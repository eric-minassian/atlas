import {
  Cartesian2,
  Cartesian3,
  Credit,
  EquirectangularPanorama,
  HeadingPitchRoll,
  Math as CesiumMath,
  Matrix4,
  PerspectiveFrustum,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
} from 'cesium';
import type { Globe } from '../globe/globe.ts';
import { WheelClassifier } from '../globe/wheel.ts';
import { Listeners } from '../lib/listeners.ts';
import { bearing, type Neighbor, type Pano, type ProviderId, type StreetProvider } from './providers.ts';

/** Meters above the ground the camera stands: about where these cameras are carried or mounted. */
const EYE = 2.5;
/** Panorama images are 2:1; anything wider than this is scaled down before it becomes a texture. */
const TEXTURE_WIDTH = 4096;
const MIN_FOV = CesiumMath.toRadians(30);
const MAX_FOV = CesiumMath.toRadians(100);
const START_FOV = CesiumMath.toRadians(80);
/**
 * Cesium's sphere starts its texture's horizontal axis on local +x (east) and
 * flips it so the image reads correctly from inside; the image's center column
 * then faces west. Rotating by the capture heading plus this turns that
 * column toward the direction the camera faced.
 */
const HEADING_OFFSET = 90;
/** A click within this angle of a neighbor's direction walks to it. */
const STEP_TOLERANCE = 60;

export interface PanoramaState {
  readonly pano: Pano;
  readonly neighbors: ReadonlyArray<Neighbor>;
  /** A panorama (or a sharper copy) is still loading. */
  readonly loading: boolean;
}

/** Fetches an image (CORS) and returns it as a canvas no wider than `width`, ready to be a texture. */
const loadTexture = async (url: string, width: number, signal: AbortSignal): Promise<HTMLCanvasElement> => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`panorama image: HTTP ${response.status}`);
  const blob = await response.blob();
  const probe = await createImageBitmap(blob);
  const w = Math.min(width, probe.width);
  const h = Math.round((probe.height * w) / probe.width);
  const bitmap =
    w === probe.width
      ? probe
      : await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  if (bitmap !== probe) probe.close();
  // A canvas rather than the bitmap itself: WebGL won't flip an ImageBitmap on upload, and Cesium
  // expects the source upright.
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
};

const creditFor = (pano: Pano) => {
  const parts = [
    `<a href="${pano.page}" target="_blank" rel="noreferrer">${pano.provider === 'mapillary' ? 'Mapillary' : 'Panoramax'}</a>`,
    ...(pano.author ? [pano.author.replaceAll('<', '&lt;')] : []),
    pano.license.href
      ? `<a href="${pano.license.href}" target="_blank" rel="noreferrer">${pano.license.label}</a>`
      : pano.license.label,
  ];
  return new Credit(parts.join(' · '));
};

/**
 * Street-level panoramas inside the globe. Opening one flies the camera down
 * to it, hides everything else (the panorama is a sphere around the camera, and
 * anything inside it would show through), and swaps the map controls for
 * looking around. Closing puts the view back where it was.
 */
export class PanoramaViewer {
  readonly changed = new Listeners<PanoramaState | undefined>();
  private current: PanoramaState | undefined;
  private primitive: EquirectangularPanorama | undefined;
  private restore: (() => void) | undefined;
  private stopControls: (() => void) | undefined;
  private abort: AbortController | undefined;
  /**
   * Ground height where the viewer entered, meters. Measured before the globe
   * is hidden (hidden, it can't answer), and kept for the walk: inside the
   * sphere nothing else is drawn, so height only places the walk markers.
   */
  private ground = 0;

  constructor(
    private readonly globe: Globe,
    private readonly providers: ReadonlyMap<ProviderId, StreetProvider>,
  ) {}

  get state(): PanoramaState | undefined {
    return this.current;
  }

  get isOpen(): boolean {
    return this.restore !== undefined;
  }

  /** The providers in use, in the order nearest-panorama searches ask them. */
  get sources(): ReadonlyArray<StreetProvider> {
    return [...this.providers.values()];
  }

  /** Opens `pano`, or moves to it when a panorama is already open. */
  async open(pano: Pano): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ pano, neighbors: this.current?.neighbors ?? [], loading: true });
    const texture = loadTexture(pano.image, TEXTURE_WIDTH, abort.signal);
    const neighbors = this.providers
      .get(pano.provider)
      ?.neighbors(pano, abort.signal)
      .catch(() => []);
    if (!this.isOpen) await this.descend(pano);
    let image: HTMLCanvasElement;
    try {
      image = await texture;
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    }
    if (abort.signal.aborted) return;
    this.show(pano, image);
    this.publish({ pano, neighbors: (await neighbors) ?? [], loading: pano.sharper !== undefined });
    if (pano.sharper) {
      try {
        const sharper = await loadTexture(pano.sharper, TEXTURE_WIDTH, abort.signal);
        if (abort.signal.aborted) return;
        this.show(pano, sharper);
      } catch {
        // The 2048 px image is already showing; a failed upgrade just leaves it.
      }
      if (!abort.signal.aborted && this.current) this.publish({ ...this.current, loading: false });
    }
  }

  /** Loads a neighbor and moves to it. */
  async go(neighbor: Neighbor): Promise<void> {
    const provider = this.providers.get(neighbor.provider);
    if (!provider) return;
    await this.open(await provider.load(neighbor.id));
  }

  /** Walks to the neighbor closest to `direction` (compass degrees), if one lies roughly that way. */
  step(direction: number): void {
    const state = this.current;
    if (!state) return;
    let best: { neighbor: Neighbor; off: number } | undefined;
    for (const neighbor of state.neighbors) {
      const off = Math.abs(((bearing(state.pano, neighbor) - direction + 540) % 360) - 180);
      if (off <= STEP_TOLERANCE && (!best || off < best.off)) best = { neighbor, off };
    }
    if (best) void this.go(best.neighbor);
  }

  /** The camera's compass heading, degrees. */
  heading(): number {
    return (CesiumMath.toDegrees(this.globe.scene.camera.heading) + 360) % 360;
  }

  /** Where on screen the walk-to marker for `neighbor` goes: on the ground a few meters toward it. */
  markerAt(neighbor: Neighbor): { x: number; y: number } | undefined {
    const state = this.current;
    if (!state) return undefined;
    const scene = this.globe.scene;
    const to = CesiumMath.toRadians(bearing(state.pano, neighbor));
    const origin = this.globe.scene.camera.positionWC;
    const enu = Transforms.eastNorthUpToFixedFrame(origin);
    const local = new Cartesian3(Math.sin(to) * 6, Math.cos(to) * 6, -EYE);
    const world = Matrix4.multiplyByPoint(enu, local, new Cartesian3());
    // Behind the camera, the projection lands mirrored on screen.
    const toPoint = Cartesian3.subtract(world, origin, new Cartesian3());
    if (Cartesian3.dot(toPoint, scene.camera.directionWC) <= 0) return undefined;
    const at = scene.cartesianToCanvasCoordinates(world, new Cartesian2());
    return at ? { x: at.x, y: at.y } : undefined;
  }

  close(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.stopControls?.();
    this.stopControls = undefined;
    if (this.primitive) this.globe.scene.primitives.remove(this.primitive);
    this.primitive = undefined;
    this.restore?.();
    this.restore = undefined;
    this.publish(undefined);
  }

  private publish(state: PanoramaState | undefined) {
    this.current = state;
    this.changed.emit(state);
  }

  /** Flies down to the panorama and takes over the scene and the controls. */
  private async descend(pano: Pano): Promise<void> {
    const { scene } = this.globe;
    const camera = scene.camera;
    const saved = {
      position: Cartesian3.clone(camera.positionWC),
      direction: Cartesian3.clone(camera.directionWC),
      up: Cartesian3.clone(camera.upWC),
      fov: camera.frustum instanceof PerspectiveFrustum ? camera.frustum.fov : undefined,
    };
    this.globe.follow(undefined);
    // A terrain sample: under Photorealistic 3D there's no globe to ask.
    this.ground = (await this.globe.groundHeights([pano]))[0] ?? 0;
    const heading = camera.heading;
    await new Promise<void>((resolve) => {
      camera.flyTo({
        destination: Cartesian3.fromDegrees(pano.lon, pano.lat, this.ground + EYE + 25),
        orientation: { heading, pitch: CesiumMath.toRadians(-25), roll: 0 },
        duration: 1.2,
        complete: resolve,
        cancel: resolve,
      });
    });
    const unisolate = this.globe.isolate();
    const controller = scene.screenSpaceCameraController;
    controller.enableInputs = false;
    if (camera.frustum instanceof PerspectiveFrustum) camera.frustum.fov = START_FOV;
    this.stopControls = this.controls();
    this.restore = () => {
      unisolate();
      controller.enableInputs = true;
      if (saved.fov !== undefined && camera.frustum instanceof PerspectiveFrustum)
        camera.frustum.fov = saved.fov;
      camera.setView({
        destination: saved.position,
        orientation: { direction: saved.direction, up: saved.up },
      });
    };
  }

  /** Puts the panorama around the camera, standing at its capture point. */
  private show(pano: Pano, image: HTMLCanvasElement) {
    const { scene } = this.globe;
    const position = Cartesian3.fromDegrees(pano.lon, pano.lat, this.ground + EYE);
    const next = new EquirectangularPanorama({
      transform: Transforms.headingPitchRollToFixedFrame(
        position,
        new HeadingPitchRoll(CesiumMath.toRadians(pano.heading + HEADING_OFFSET), 0, 0),
      ),
      image,
      credit: creditFor(pano),
    });
    scene.primitives.add(next);
    if (this.primitive) scene.primitives.remove(this.primitive);
    this.primitive = next;
    const camera = scene.camera;
    camera.setView({
      destination: position,
      orientation: { heading: camera.heading, pitch: Math.max(-0.6, Math.min(0.6, camera.pitch)), roll: 0 },
    });
  }

  /**
   * Drag (or scroll a trackpad) to look, wheel or pinch to zoom, click to walk
   * toward where you clicked. Returns the teardown.
   */
  private controls(): () => void {
    const { scene } = this.globe;
    const camera = scene.camera;
    const handler = new ScreenSpaceEventHandler(scene.canvas);
    const perPixel = () =>
      (camera.frustum instanceof PerspectiveFrustum ? (camera.frustum.fov ?? START_FOV) : START_FOV) /
      Math.max(scene.canvas.clientWidth, scene.canvas.clientHeight);
    const look = (dHeading: number, dPitch: number) =>
      camera.setView({
        orientation: {
          heading: camera.heading + dHeading,
          pitch: CesiumMath.clamp(camera.pitch + dPitch, -1.45, 1.45),
          roll: 0,
        },
      });
    /** Narrows the view by e^`amount` (positive zooms in). */
    const zoom = (amount: number) => {
      if (!(camera.frustum instanceof PerspectiveFrustum)) return;
      camera.frustum.fov = CesiumMath.clamp(
        (camera.frustum.fov ?? START_FOV) * Math.exp(-amount),
        MIN_FOV,
        MAX_FOV,
      );
    };
    let dragging: { x: number; y: number; moved: boolean } | undefined;
    handler.setInputAction((event: { position: Cartesian2 }) => {
      dragging = { x: event.position.x, y: event.position.y, moved: false };
    }, ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (!dragging || !(camera.frustum instanceof PerspectiveFrustum)) return;
      const dx = event.endPosition.x - dragging.x;
      const dy = event.endPosition.y - dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragging.moved = true;
      dragging.x = event.endPosition.x;
      dragging.y = event.endPosition.y;
      // The image follows the pointer, as if grabbing it.
      look(-dx * perPixel(), dy * perPixel());
    }, ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((event: { position: Cartesian2 }) => {
      const click = dragging && !dragging.moved;
      dragging = undefined;
      if (!click) return;
      const ray = camera.getPickRay(event.position);
      if (!ray) return;
      const enu = Matrix4.inverseTransformation(
        Transforms.eastNorthUpToFixedFrame(camera.positionWC),
        new Matrix4(),
      );
      const local = Matrix4.multiplyByPointAsVector(enu, ray.direction, new Cartesian3());
      this.step(((Math.atan2(local.x, local.y) * 180) / Math.PI + 360) % 360);
    }, ScreenSpaceEventType.LEFT_UP);
    // The globe's navigator keeps the page from scrolling or zooming; the panorama reads the wheel itself.
    const classifier = new WheelClassifier();
    const onWheel = (event: WheelEvent) => {
      const intent = classifier.classify(event);
      if (!intent) return;
      if (intent.kind === 'zoom') zoom(intent.amount * 0.1);
      else if (intent.kind === 'pinch') zoom(intent.amount);
      // A trackpad scroll moves the image the way the fingers go, like a drag.
      else look(intent.dx * perPixel(), -intent.dy * perPixel());
    };
    // Safari's trackpad pinch.
    let scale = 1;
    const onGesture = (event: Event) => {
      const next = (event as Event & { scale?: number }).scale ?? 1;
      if (event.type === 'gesturestart') scale = 1;
      else if (event.type === 'gesturechange') zoom(Math.log(next / scale));
      scale = next;
    };
    const canvas = scene.canvas;
    canvas.addEventListener('wheel', onWheel, { passive: true });
    for (const type of ['gesturestart', 'gesturechange'] as const) canvas.addEventListener(type, onGesture);
    return () => {
      handler.destroy();
      canvas.removeEventListener('wheel', onWheel);
      for (const type of ['gesturestart', 'gesturechange'] as const)
        canvas.removeEventListener(type, onGesture);
    };
  }

  destroy(): void {
    this.close();
  }
}
