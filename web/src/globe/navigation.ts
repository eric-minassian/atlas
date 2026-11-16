import {
  Cartesian2,
  Cartesian3,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  Ray,
  type Scene,
  Transforms,
} from 'cesium';
import { hitSphere, pitchFor, rotateCamera, rotationBetween } from './camera.ts';
import { WheelClassifier } from './wheel.ts';

/** One mouse-wheel notch (or a key press) brings the view this much closer. */
const ZOOM_PER_NOTCH = Math.log(1.6);
const ZOOM_PER_STEP = Math.log(2);
/**
 * Time constants (s) the camera eases toward its target with: a wheel notch
 * or a step lands in about three of these. A pinch is direct.
 */
const WHEEL_EASE = 0.075;
const STEP_EASE = 0.1;
/** How strongly zooming pulls the pitch toward `pitchFor`: the share left after an e-fold of distance is e^-rate. */
const TILT_RATE = 1.3;
/** Never closer than this to what's under the cursor, nor higher than this above the Earth (far enough to frame the geostationary ring). */
const MIN_DISTANCE = 5;
const MAX_HEIGHT = 70_000_000;
/** Meters the camera keeps above the ground. */
const CLEARANCE = 2;
/**
 * Below this height zooming dollies straight toward the point under the
 * cursor; above it the camera moves up or down and the globe turns under it,
 * so a view from space stays a view straight down.
 */
const DOLLY_BELOW = 150_000;
/** Above this, the ellipsoid stands in for the ground when picking (terrain is too small to matter). */
const PICK_TERRAIN_BELOW = 200_000;
/** Pitch limits: straight down, and a little below the horizon. */
const MIN_PITCH = -CesiumMath.PI_OVER_TWO;
const MAX_PITCH = CesiumMath.toRadians(-3);
/** Keyboard panning (CSS px/s at the center of the screen) and orbiting (rad/s). */
const KEY_PAN_SPEED = 700;
const KEY_TURN_SPEED = CesiumMath.toRadians(80);
const KEY_TILT_SPEED = CesiumMath.toRadians(45);
const KEY_EASE = 0.08;
const MIN_KEY_HOLD_MS = 180;
/** Following something: radians of orbit per pixel scrolled. */
const ORBIT_PER_PIXEL = (2 * Math.PI) / 1400;
/** Input this close together (ms), at the same spot, is one gesture: it keeps the point it grabbed. */
const GESTURE_MS = 250;
/** Above this latitude "north" turns too fast to hold while panning. */
const HOLD_NORTH_BELOW = CesiumMath.toRadians(80);

export interface NavigationHost {
  readonly scene: Scene;
  /** The surface (terrain or 3D tiles) under a screen position, or undefined over sky. */
  surfaceAt(position: Cartesian2): Cartesian3 | undefined;
  /** Locked onto a moving thing: zooming changes the range, panning orbits it. */
  readonly isFollowing: boolean;
  /** A panorama has the controls. */
  readonly isIsolated: boolean;
}

const scratchRay = new Ray();
const scratchAxis = new Cartesian3();
const scratchEnu = new Matrix4();
const scratchInverse = new Matrix4();
const scratchLocal = new Cartesian3();
const scratchScreen = new Cartesian2();

/** The angle `a - b` wrapped into (-π, π]. */
const angleDiff = (a: number, b: number) => CesiumMath.negativePiToPi(a - b);

interface ZoomTarget {
  /** Log of the distance factor still to apply: negative closes in. */
  pending: number;
  ease: number;
  readonly at: Cartesian2;
  /** The 3D point that stays under `at`; undefined over sky. */
  readonly anchor: Cartesian3 | undefined;
}

/** Where a gesture took hold: the cursor, and the point (and its radius) it keeps hold of. */
interface Grab {
  readonly cursor: Cartesian2;
  readonly at: Cartesian2;
  readonly anchor: Cartesian3 | undefined;
  time: number;
}

/**
 * Camera input on top of Cesium's: the mouse wheel and trackpad pinch zoom
 * toward the cursor, easing over a few frames; a trackpad's two-finger scroll
 * pans; Safari's trackpad rotate turns the view; the keyboard pans, zooms and
 * orbits; double-click zooms in. Dragging (pan, and right-drag or modifier-drag
 * to orbit) and touch stay with Cesium. Zooming in near the ground tilts the
 * view toward the horizon, and zooming out straightens it.
 */
export class Navigator {
  /** `performance.now()` of the latest input, for callers deciding whether the viewer is busy. */
  lastInput = Number.NEGATIVE_INFINITY;
  private readonly wheel = new WheelClassifier();
  private zoom: ZoomTarget | undefined;
  /** Scrolled pixels not yet applied, and where the scroll took hold. */
  private readonly pan = { dx: 0, dy: 0 };
  private panGrab: Grab | undefined;
  private zoomGrab: Grab | undefined;
  /** Held keys, with when each went down. */
  private readonly keys = new Map<string, number>();
  private readonly releases = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly keyVelocity = { x: 0, y: 0, turn: 0, tilt: 0 };
  private resetting = false;
  private gesture:
    | { scale: number; rotation: number; at: Cartesian2; anchor: Cartesian3 | undefined }
    | undefined;
  private lastFrame = performance.now();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly stops: Array<() => void> = [];

  constructor(private readonly host: NavigationHost) {
    const { scene } = host;
    const canvas = scene.canvas;
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, listener as EventListener, options);
      this.stops.push(() => target.removeEventListener(type, listener as EventListener, options));
    };
    listen(canvas, 'wheel', (event) => this.onWheel(event), { passive: false });
    listen(canvas, 'dblclick', (event) => this.onDoubleClick(event));
    // Any press hands the camera to Cesium's drag controls: drop what was still easing in.
    listen(canvas, 'pointerdown', () => this.stop());
    listen(window, 'keydown', (event) => this.onKey(event, true));
    listen(window, 'keyup', (event) => this.onKey(event, false));
    listen(window, 'blur', () => this.keys.clear());
    // Safari reports trackpad pinch and rotate as gesture events (and not as ctrl + wheel).
    for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const)
      listen(canvas, type as keyof HTMLElementEventMap, (event) => this.onGesture(event as GestureLike));
    this.stops.push(scene.preRender.addEventListener(() => this.frame()));
  }

  /** Steps the zoom in (`1`) or out (`-1`) around the center of the screen, as the +/− keys do. */
  zoomBy(direction: 1 | -1): void {
    this.input();
    this.queueZoom(-direction * ZOOM_PER_STEP, this.center(), STEP_EASE);
  }

  /** Turns the view back to north up and the pitch that suits its height. */
  resetNorth(): void {
    this.input();
    this.resetting = true;
  }

  /** Whether the camera is being moved from here (input easing in, keys held). */
  get busy(): boolean {
    return (
      this.zoom !== undefined ||
      this.pan.dx !== 0 ||
      this.pan.dy !== 0 ||
      this.keys.size > 0 ||
      this.resetting
    );
  }

  destroy(): void {
    for (const stop of this.stops) stop();
    for (const timer of this.releases.values()) clearTimeout(timer);
  }

  /** A new input from the viewer: it takes over from a flight or a reset in progress. */
  private input() {
    this.lastInput = performance.now();
    this.resetting = false;
    // A search's flight gives way to whoever takes the controls.
    this.host.scene.camera.cancelFlight();
  }

  private stop() {
    this.zoom = undefined;
    this.pan.dx = 0;
    this.pan.dy = 0;
    this.panGrab = undefined;
    this.zoomGrab = undefined;
    this.resetting = false;
  }

  private center(): Cartesian2 {
    const canvas = this.host.scene.canvas;
    return new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  }

  private screenPoint(event: MouseEvent): Cartesian2 {
    const rect = this.host.scene.canvas.getBoundingClientRect();
    return new Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
  }

  private onWheel(event: WheelEvent) {
    // Never the page's own zoom or scroll (or Safari's back-swipe) over the globe.
    event.preventDefault();
    if (this.host.isIsolated) return;
    const intent = this.wheel.classify(event);
    if (!intent || this.gesture) return;
    this.input();
    const at = this.screenPoint(event);
    switch (intent.kind) {
      case 'zoom':
        this.queueZoom(-intent.amount * ZOOM_PER_NOTCH, at, WHEEL_EASE);
        break;
      case 'pinch':
        this.queueZoom(-intent.amount, at, 0);
        break;
      case 'scroll':
        if (event.altKey || event.shiftKey)
          this.orbitBy(intent.dx * ORBIT_PER_PIXEL, intent.dy * ORBIT_PER_PIXEL);
        else this.queuePan(at, intent.dx, intent.dy);
        break;
      default:
        intent satisfies never;
    }
  }

  private onDoubleClick(event: MouseEvent) {
    if (this.host.isIsolated) return;
    this.input();
    const out = event.shiftKey || event.altKey;
    this.queueZoom((out ? 1 : -1) * ZOOM_PER_STEP, this.screenPoint(event), STEP_EASE);
  }

  private onGesture(event: GestureLike) {
    event.preventDefault();
    if (this.host.isIsolated) return;
    this.input();
    const at = this.screenPoint(event);
    if (event.type === 'gesturestart') {
      this.gesture = { scale: 1, rotation: 0, at, anchor: this.anchorAt(at) };
      return;
    }
    const gesture = this.gesture;
    if (!gesture) return;
    if (event.type === 'gestureend') {
      this.gesture = undefined;
      return;
    }
    const zoom = Math.log(event.scale / gesture.scale);
    const turn = CesiumMath.toRadians(event.rotation - gesture.rotation);
    gesture.scale = event.scale;
    gesture.rotation = event.rotation;
    if (Number.isFinite(zoom) && zoom !== 0) this.queueZoom(-zoom, gesture.at, 0, gesture.anchor);
    if (turn !== 0) this.turnAbout(gesture.anchor, turn);
  }

  private onKey(event: KeyboardEvent, down: boolean) {
    const key = event.key;
    if (!down) {
      for (const held of [key, `orbit:${key}`]) {
        const since = this.keys.get(held);
        if (since === undefined) continue;
        // A tap still moves a useful distance: the key counts as held for at least `MIN_KEY_HOLD_MS`.
        const left = since + MIN_KEY_HOLD_MS - performance.now();
        clearTimeout(this.releases.get(held));
        if (left <= 0) this.keys.delete(held);
        else
          this.releases.set(
            held,
            setTimeout(() => this.keys.delete(held), left),
          );
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || this.host.isIsolated || !keyboardTarget(event.target)) return;
    if (key === '+' || key === '=') {
      event.preventDefault();
      this.zoomBy(1);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      this.zoomBy(-1);
    } else if (key === 'n' || key === 'N') {
      this.resetNorth();
    } else if (key.startsWith('Arrow')) {
      event.preventDefault();
      this.input();
      // Shift turns arrow keys from panning to orbiting; a key that's down stays whichever it began as.
      const held = event.shiftKey ? `orbit:${key}` : key;
      clearTimeout(this.releases.get(held));
      if (!event.repeat || !this.keys.has(held)) this.keys.set(held, performance.now());
    }
  }

  /** The point to keep under `at` while zooming there. */
  private anchorAt(at: Cartesian2): Cartesian3 | undefined {
    const { scene } = this.host;
    const camera = scene.camera;
    if (camera.positionCartographic.height > PICK_TERRAIN_BELOW)
      return camera.pickEllipsoid(at, scene.globe.ellipsoid) ?? undefined;
    return this.host.surfaceAt(at) ?? camera.pickEllipsoid(at, scene.globe.ellipsoid) ?? undefined;
  }

  /**
   * The grab a gesture at `cursor` continues, or a new one from `take`. Picking
   * again mid-gesture would drift (and costs a ray cast against the terrain).
   */
  private regrab(
    previous: Grab | undefined,
    cursor: Cartesian2,
    take: () => Omit<Grab, 'cursor' | 'time'>,
  ): Grab {
    const now = performance.now();
    if (previous && now - previous.time < GESTURE_MS && Cartesian2.distance(previous.cursor, cursor) < 3) {
      previous.time = now;
      return previous;
    }
    return { cursor: Cartesian2.clone(cursor), time: now, ...take() };
  }

  private queueZoom(log: number, at: Cartesian2, ease: number, anchor?: Cartesian3) {
    this.zoomGrab = this.regrab(this.zoomGrab, at, () => {
      const under = anchor ?? this.anchorAt(at);
      // Off the Earth (space, sky): zoom about the center of the screen instead.
      if (under) return { at, anchor: under };
      const center = this.center();
      return { at: center, anchor: this.anchorAt(center) };
    });
    const grab = this.zoomGrab;
    // What's left of a zoom elsewhere carries over, so moving the cursor mid-zoom doesn't cut it short.
    const pending = CesiumMath.clamp((this.zoom?.pending ?? 0) + log, -8, 8);
    this.zoom = { pending, ease: this.reducedMotion.matches ? 0 : ease, at: grab.at, anchor: grab.anchor };
    this.pan.dx = 0;
    this.pan.dy = 0;
  }

  private queuePan(cursor: Cartesian2, dx: number, dy: number) {
    this.panGrab = this.regrab(this.panGrab, cursor, () => {
      const at = this.panPoint(cursor) ?? cursor;
      return { at, anchor: this.anchorAt(at) };
    });
    this.pan.dx += dx;
    this.pan.dy += dy;
    this.zoom = undefined;
  }

  /** The sphere a pan turns the globe on: through what was grabbed, or sea level under the camera. */
  private panRadius(anchor: Cartesian3 | undefined): number {
    const camera = this.host.scene.camera;
    return anchor
      ? Cartesian3.magnitude(anchor)
      : Cartesian3.magnitude(camera.positionWC) - camera.positionCartographic.height;
  }

  /**
   * Where to grab the ground when panning: under the cursor, unless that's far
   * toward the horizon in a tilted view, where a small scroll would cover
   * kilometers; then the center of the screen.
   */
  private panPoint(at: Cartesian2): Cartesian2 | undefined {
    const camera = this.host.scene.camera;
    const center = this.center();
    const ellipsoid = this.host.scene.globe.ellipsoid;
    const atCursor = camera.pickEllipsoid(at, ellipsoid);
    const atCenter = camera.pickEllipsoid(center, ellipsoid);
    if (!atCursor) return atCenter ? center : undefined;
    if (!atCenter) return at;
    const far =
      Cartesian3.distance(camera.positionWC, atCursor) > 3 * Cartesian3.distance(camera.positionWC, atCenter);
    return far ? center : at;
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.host.isIsolated) {
      this.stop();
      this.keys.clear();
      return;
    }
    const zoom = this.zoom;
    if (zoom) {
      const share = zoom.ease <= 0 ? 1 : 1 - Math.exp(-dt / zoom.ease);
      let step = zoom.pending * share;
      if (Math.abs(zoom.pending - step) < 1e-4) step = zoom.pending;
      const applied = this.applyZoom(step, zoom.at, zoom.anchor);
      zoom.pending -= step;
      // At a limit (the ground, the top): what's left would only push against it.
      if (Math.abs(applied - step) > 1e-6 || Math.abs(zoom.pending) < 1e-4) this.zoom = undefined;
    }
    const grab = this.panGrab;
    if (grab && (this.pan.dx !== 0 || this.pan.dy !== 0))
      this.applyPan(grab.at, this.pan.dx, this.pan.dy, this.panRadius(grab.anchor));
    this.pan.dx = 0;
    this.pan.dy = 0;
    this.keyStep(dt);
    if (this.resetting) this.resetStep(dt);
  }

  /**
   * Moves the camera `log` (an e-fold per unit) closer to or farther from
   * `anchor`, keeping it under `at`. Returns the log actually applied, less at
   * a limit.
   */
  private applyZoom(log: number, at: Cartesian2, anchor: Cartesian3 | undefined): number {
    const { scene } = this.host;
    const camera = scene.camera;
    if (this.host.isFollowing) {
      // Closer to or farther from what's followed, at the same angle.
      const range = Cartesian3.magnitude(camera.position);
      const next = CesiumMath.clamp(range * Math.exp(log), 50, MAX_HEIGHT);
      Cartesian3.multiplyByScalar(camera.position, next / range, camera.position);
      return Math.log(next / range);
    }
    const height = camera.positionCartographic.height;
    let factor = Math.exp(log);
    if (log > 0 && height * factor > MAX_HEIGHT) factor = Math.max(1, MAX_HEIGHT / Math.max(height, 1));
    if (!anchor) {
      // Over sky: straight up or down.
      const up = Cartesian3.normalize(camera.positionWC, scratchAxis);
      Cartesian3.add(
        camera.position,
        Cartesian3.multiplyByScalar(up, height * (factor - 1), up),
        camera.position,
      );
      return Math.log(factor);
    }
    const position = camera.position;
    const distance = Cartesian3.distance(position, anchor);
    if (log < 0 && distance * factor < MIN_DISTANCE) factor = Math.min(1, MIN_DISTANCE / distance);
    if (factor === 1) return 0;
    const radius = Cartesian3.magnitude(anchor);
    if (height < DOLLY_BELOW) {
      // Along the line to the anchor: it stays exactly where it is on screen.
      Cartesian3.subtract(position, anchor, position);
      Cartesian3.multiplyByScalar(position, factor, position);
      Cartesian3.add(position, anchor, position);
    } else {
      // Up or down, then turn the globe so the anchor is back under the cursor.
      const above = Cartesian3.magnitude(position) - radius;
      Cartesian3.multiplyByScalar(
        Cartesian3.normalize(position, position),
        radius + above * factor,
        position,
      );
    }
    this.tiltWithZoom(log, radius);
    const north = camera.heading;
    // Twice: holding the heading turns about the center, which nudges the anchor; the second pass settles it.
    for (let pass = 0; pass < 2; pass++) {
      this.reanchor(at, anchor, radius);
      this.holdHeading(north, radius);
    }
    this.keepAboveGround();
    return Math.log(factor);
  }

  /** Eases the pitch toward the one that suits the height, in the zoom's direction only. */
  private tiltWithZoom(log: number, radius: number) {
    const camera = this.host.scene.camera;
    const target = pitchFor(camera.positionCartographic.height);
    const pitch = camera.pitch;
    const zoomingIn = log < 0;
    if (zoomingIn ? pitch >= target - 1e-3 : pitch <= target + 1e-3) return;
    const share = 1 - Math.exp(-Math.abs(log) * TILT_RATE);
    this.orbitAboutCenter(0, (target - pitch) * share, radius);
  }

  /** Turns the globe so the ray through `at` meets `anchor` again. */
  private reanchor(at: Cartesian2, anchor: Cartesian3, radius: number) {
    const camera = this.host.scene.camera;
    const ray = camera.getPickRay(at, scratchRay);
    const hit = ray && hitSphere(ray, radius, new Cartesian3());
    if (!hit) return;
    const rotation = rotationBetween(hit, anchor, scratchAxis);
    if (rotation) rotateCamera(camera, rotation.axis, rotation.angle);
  }

  /**
   * Pans so the content moves by (-dx, -dy) pixels: the point under
   * `at + (dx, dy)` comes to `at`. The globe turns under the camera, keeping
   * its heading.
   */
  private applyPan(at: Cartesian2, dx: number, dy: number, radius: number) {
    const camera = this.host.scene.camera;
    if (this.host.isFollowing) {
      this.orbitBy(dx * ORBIT_PER_PIXEL, dy * ORBIT_PER_PIXEL);
      return;
    }
    const ray = camera.getPickRay(at, scratchRay);
    const from = ray && hitSphere(ray, radius, new Cartesian3());
    if (!from) return;
    // Near the edge of the Earth the far point can fall off it: take a shorter step the same way.
    for (let share = 1; share >= 1 / 16; share /= 2) {
      scratchScreen.x = at.x + dx * share;
      scratchScreen.y = at.y + dy * share;
      const towardRay = camera.getPickRay(scratchScreen, new Ray());
      const to = towardRay && hitSphere(towardRay, radius, new Cartesian3());
      if (!to) continue;
      const rotation = rotationBetween(from, to, scratchAxis);
      if (!rotation) return;
      const heading = camera.heading;
      rotateCamera(camera, rotation.axis, rotation.angle / share);
      this.holdHeading(heading, radius);
      return;
    }
  }

  /** Undoes the twist a turn of the globe gives the heading, about the center of the screen. */
  private holdHeading(heading: number, radius: number) {
    const camera = this.host.scene.camera;
    if (Math.abs(camera.positionCartographic.latitude) > HOLD_NORTH_BELOW) return;
    const twist = angleDiff(camera.heading, heading);
    if (Math.abs(twist) < 1e-9) return;
    const pivot = this.centerPivot(radius) ?? camera.positionWC;
    // Turning the camera counterclockwise (seen from above) lowers its heading.
    rotateCamera(camera, Cartesian3.normalize(pivot, scratchAxis), twist);
  }

  /** The point at the center of the screen on the sphere of `radius`, if the center isn't sky. */
  private centerPivot(radius?: number): Cartesian3 | undefined {
    const { scene } = this.host;
    const camera = scene.camera;
    const ray = camera.getPickRay(this.center(), scratchRay);
    if (!ray) return undefined;
    if (radius !== undefined) return hitSphere(ray, radius, new Cartesian3());
    return camera.pickEllipsoid(this.center(), scene.globe.ellipsoid);
  }

  /**
   * Orbits the center of the screen: `turn` radians of heading, `tilt` of
   * pitch (positive toward the horizon). Following something, orbits it.
   */
  private orbitBy(turn: number, tilt: number) {
    const camera = this.host.scene.camera;
    if (this.host.isFollowing) {
      camera.rotateRight(turn);
      camera.rotateUp(tilt);
      return;
    }
    this.orbitAboutCenter(turn, tilt);
  }

  private orbitAboutCenter(turn: number, tilt: number, radius?: number) {
    const { scene } = this.host;
    const camera = scene.camera;
    const pivot = this.centerPivot(radius) ?? this.centerPivot();
    if (!pivot) return;
    if (turn !== 0) rotateCamera(camera, Cartesian3.normalize(pivot, scratchAxis), -turn);
    if (tilt === 0) return;
    // The camera's offset from the pivot in the pivot's east-north-up frame gives its heading and pitch there.
    const enu = Transforms.eastNorthUpToFixedFrame(pivot, scene.globe.ellipsoid, scratchEnu);
    const local = Matrix4.multiplyByPoint(
      Matrix4.inverseTransformation(enu, scratchInverse),
      camera.positionWC,
      scratchLocal,
    );
    const range = Cartesian3.magnitude(local);
    if (range < 1e-3) return;
    // The camera looks straight at the pivot, so its own heading is the heading there (and stays
    // defined looking straight down, where the offset's direction is noise).
    const heading = camera.heading;
    const pitch = Math.asin(CesiumMath.clamp(-local.z / range, -1, 1));
    const next = CesiumMath.clamp(pitch + tilt, MIN_PITCH, MAX_PITCH);
    if (Math.abs(next - pitch) < 1e-6) return;
    camera.lookAt(pivot, new HeadingPitchRange(heading, next, range));
    camera.lookAtTransform(Matrix4.IDENTITY);
  }

  /** Turns the view about the vertical through `anchor` (the center of the screen when undefined). */
  private turnAbout(anchor: Cartesian3 | undefined, angle: number) {
    const camera = this.host.scene.camera;
    if (this.host.isFollowing) {
      camera.rotateRight(-angle);
      return;
    }
    const pivot = anchor ?? this.centerPivot();
    if (pivot) rotateCamera(camera, Cartesian3.normalize(pivot, scratchAxis), angle);
  }

  private keepAboveGround() {
    const { scene } = this.host;
    if (!scene.globe.show) return;
    const camera = scene.camera;
    const carto = camera.positionCartographic;
    const ground = scene.globe.getHeight(carto);
    if (ground === undefined || carto.height >= ground + CLEARANCE) return;
    Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      ground + CLEARANCE,
      scene.globe.ellipsoid,
      camera.position,
    );
  }

  /** Held arrow keys: pan or orbit at a speed that eases in and out. */
  private keyStep(dt: number): void {
    const held = (key: string) => (this.keys.has(key) ? 1 : 0);
    const target = {
      x: held('ArrowRight') - held('ArrowLeft'),
      y: held('ArrowDown') - held('ArrowUp'),
      turn: held('orbit:ArrowRight') - held('orbit:ArrowLeft'),
      tilt: held('orbit:ArrowUp') - held('orbit:ArrowDown'),
    };
    const share = 1 - Math.exp(-dt / KEY_EASE);
    const v = this.keyVelocity;
    let moving = false;
    for (const axis of ['x', 'y', 'turn', 'tilt'] as const) {
      v[axis] += (target[axis] - v[axis]) * share;
      if (Math.abs(v[axis]) < 1e-3 && target[axis] === 0) v[axis] = 0;
      if (v[axis] !== 0) moving = true;
    }
    if (!moving) return;
    this.lastInput = performance.now();
    if (v.x || v.y) {
      const center = this.center();
      this.applyPan(
        center,
        v.x * KEY_PAN_SPEED * dt,
        v.y * KEY_PAN_SPEED * dt,
        this.panRadius(this.anchorAt(center)),
      );
    }
    if (v.turn || v.tilt) this.orbitBy(v.turn * KEY_TURN_SPEED * dt, v.tilt * KEY_TILT_SPEED * dt);
  }

  /** One frame of turning back to north up and the pitch that suits the height. */
  private resetStep(dt: number) {
    const camera = this.host.scene.camera;
    const share = this.reducedMotion.matches ? 1 : 1 - Math.exp(-dt / STEP_EASE);
    const heading = angleDiff(0, camera.heading);
    const pitch = this.host.isFollowing ? camera.pitch : pitchFor(camera.positionCartographic.height);
    const tilt = pitch - camera.pitch;
    const done = Math.abs(heading) < 1e-3 && Math.abs(tilt) < 1e-3;
    this.orbitBy(done ? heading : heading * share, done ? tilt : tilt * share);
    if (done) this.resetting = false;
  }
}

/** Safari's `GestureEvent` (not in TypeScript's DOM types). */
interface GestureLike extends MouseEvent {
  readonly scale: number;
  readonly rotation: number;
}

/** Whether a key press is for the globe rather than a control that has focus. */
const keyboardTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable) return false;
  // Controls that use arrow keys themselves, and anything in a dialog.
  return !target.closest(
    'input, textarea, select, [role="slider"], [role="radio"], [role="tab"], [role="option"], [role="menuitem"], [role="dialog"]',
  );
};
