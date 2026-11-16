import {
  ArcGisBaseMapType,
  ArcGisMapServerImageryProvider,
  ArcGisMapService,
  buildModuleUrl,
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Cartographic,
  type Cesium3DTileset,
  CesiumWidget,
  ClockStep,
  Color,
  Credit,
  createGooglePhotorealistic3DTileset,
  createWorldTerrainAsync,
  defined,
  DirectionalLight,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Ion,
  JulianDate,
  KeyboardEventModifier,
  Math as CesiumMath,
  Matrix4,
  Rectangle,
  sampleTerrain,
  type Scene,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SunLight,
  Terrain,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
} from 'cesium';
import type { Bounds } from '../../../src/area.ts';
import type { ClientConfig } from '../../../src/domain.ts';
import { Listeners } from '../lib/listeners.ts';
import { Navigator } from './navigation.ts';
import { choosePixelRatio } from './pixels.ts';

/** What a click or hover landed on: something a layer drew, a point on Earth, or space. */
export type Pick =
  | { readonly kind: 'entity'; readonly layer: string; readonly key: string }
  | { readonly kind: 'place'; readonly lat: number; readonly lon: number }
  | { readonly kind: 'none' };

/** Layers tag the primitives they draw with this as `id`, so picks map back to them. */
export interface PickId {
  readonly layer: string;
  readonly key: string;
}

const isPickId = (value: unknown): value is PickId =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PickId).layer === 'string' &&
  typeof (value as PickId).key === 'string';

/**
 * `satellite`: open imagery that sharpens as you zoom (NASA, then Sentinel-2,
 * then Esri), on terrain. `photoreal`: Google's photorealistic 3D tiles, and
 * nothing else that's a map: Google's terms forbid showing their tiles with or
 * near other map imagery, so every base-map layer turns off in this mode.
 */
export type Basemap = 'satellite' | 'photoreal';

/** Where the camera is and what it sees. */
export interface View {
  /** Camera height above the ellipsoid, meters. */
  readonly height: number;
  /** The part of the Earth in view; undefined when looking only at sky. */
  readonly bounds: Bounds | undefined;
  /** The point at the center of the screen; undefined when that's sky. */
  readonly center: { readonly lat: number; readonly lon: number } | undefined;
}

/** A NASA GIBS layer in Web Mercator (`GoogleMapsCompatible_Level<level>`). */
export const gibs = (
  layer: string,
  options: { readonly level: number; readonly format: 'jpg' | 'png'; readonly time?: string },
) =>
  new UrlTemplateImageryProvider({
    url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${options.time ?? 'default'}/GoogleMapsCompatible_Level${options.level}/{z}/{y}/{x}.${options.format}`,
    tilingScheme: new WebMercatorTilingScheme(),
    maximumLevel: options.level,
    credit: new Credit('NASA GIBS'),
  });

/**
 * Terrain levels at which each sharper imagery source takes over: Blue Marble
 * (≈600 m/px) runs out around level 7, Sentinel-2 cloudless (10 m) carries the
 * regional scale, and Esri's 0.3–1 m imagery takes over for cities.
 */
const SENTINEL_FROM_LEVEL = 6;
const ESRI_FROM_LEVEL = 11;
/** The NASA reference overlay (borders, coarse labels) gives way to the vector labels below this level. */
const REFERENCE_UNTIL_LEVEL = 9;

/**
 * Ground heights outside these (meters above the ellipsoid) come from terrain
 * loaded only coarsely, whose triangles can sit kilometers off the surface far
 * from the camera: the Dead Sea shore and Everest's summit, with margin.
 */
const plausible = (height: number | undefined): number | undefined =>
  height !== undefined && height > -600 && height < 9_000 ? height : undefined;

/** Terrain level heights are sampled at without the globe: about 20 m apart, plenty for a marker. */
const TERRAIN_SAMPLE_LEVEL = 13;

/** Mean Earth radius, and the height of the highest ground a marker can sit on (with margin). */
const EARTH_RADIUS = 6_371_000;
const HIGHEST_GROUND = 9_000;

/** How far the camera sees before the Earth's curve hides the ground (and ground as high as Everest). */
export const horizonDistance = (height: number): number => {
  const h = Math.max(0, height);
  return (
    Math.sqrt((EARTH_RADIUS + h) ** 2 - EARTH_RADIUS ** 2) +
    Math.sqrt((EARTH_RADIUS + HIGHEST_GROUND) ** 2 - EARTH_RADIUS ** 2)
  );
};

/** With nothing moving or loading for this long, the globe draws at `IDLE_FRAME_RATE`. */
const IDLE_AFTER_MS = 1500;
const IDLE_FRAME_RATE = 30;
/** Hover picks wait this long after the camera last moved: a pick stalls the GPU, and nothing holds still yet. */
const HOVER_SETTLE_MS = 120;
const HOVER_INTERVAL_MS = 80;

/** Below this camera height, 3D models are lit from the viewer rather than the Sun. */
const VIEWER_LIGHT_BELOW = 200_000;

/** Picks things layers drew that aren't tagged with a `PickId` (3D tile features). */
export type Picker = (picked: unknown) => PickId | undefined;

export class Globe {
  readonly widget: CesiumWidget;
  readonly scene: Scene;
  readonly config: ClientConfig;
  /** Fires on every camera change (a few times a second while moving): cheap work only. */
  readonly viewChanged = new Listeners<View>();
  /** Fires when the camera stops moving: load data for the new view here. */
  readonly viewSettled = new Listeners<View>();
  readonly basemapChanged = new Listeners<Basemap>();
  /** A click on the globe, and what's under the pointer as it moves (client coordinates). */
  readonly clicked = new Listeners<Pick>();
  readonly hovered = new Listeners<{ readonly pick: Pick; readonly x: number; readonly y: number }>();
  /**
   * Drawing-buffer pixels per CSS pixel, fixed for the page. Cesium sizes
   * what it draws in CSS pixels at any density; billboard images are
   * rasterized at this one (`svgIcon`) so they aren't upscaled.
   */
  readonly pixelRatio: number;
  readonly navigation: Navigator;
  private currentView: View = { height: Number.POSITIVE_INFINITY, bounds: undefined, center: undefined };
  private currentBasemap: Basemap = 'satellite';
  private readonly day: ImageryLayer;
  private readonly night: ImageryLayer;
  private readonly satelliteImagery: ImageryLayer[] = [];
  private readonly reference: ImageryLayer[];
  private photoreal: Cesium3DTileset | undefined;
  private photorealLoading: Promise<Cesium3DTileset | undefined> | undefined;
  private readonly pickers = new Set<Picker>();
  private isolated = false;
  private readonly handler: ScreenSpaceEventHandler;
  private following: (() => Cartesian3 | undefined) | undefined;
  private readonly cleanup: Array<() => void> = [];
  /** `performance.now()` when the camera last moved, and when the viewer last did anything. */
  private lastMotion = performance.now();
  private lastActivity = performance.now();
  private tilesLoading = true;
  private pointer: { readonly x: number; readonly y: number } | undefined;
  private pressed = false;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHover = 0;

  constructor(container: HTMLElement, config: ClientConfig, creditContainer: HTMLElement) {
    this.config = config;
    if (config.keys.cesiumIon) Ion.defaultAccessToken = config.keys.cesiumIon;
    this.pixelRatio = choosePixelRatio(window.devicePixelRatio || 1, screen.width, screen.height);
    this.widget = new CesiumWidget(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      scene3DOnly: true,
      // At high density each pixel is small enough that 2 samples smooth edges as well as 4 do at 1×.
      msaaSamples: this.pixelRatio >= 1.5 ? 2 : 4,
      useBrowserRecommendedResolution: false,
      creditContainer,
    });
    this.scene = this.widget.scene;
    const { scene } = this;
    const globe = scene.globe;
    this.keepPixelRatio();

    globe.baseColor = Color.fromCssColorString('#0b1422');
    globe.enableLighting = true;
    globe.dynamicAtmosphereLighting = true;
    globe.dynamicAtmosphereLightingFromSun = true;
    globe.showGroundAtmosphere = true;
    globe.maximumScreenSpaceError = 1.5;
    // Keep terrain tiles around the view loaded, so panning near the ground doesn't show holes.
    globe.preloadSiblings = true;
    globe.tileCacheSize = 300;
    scene.backgroundColor = Color.BLACK;
    scene.highDynamicRange = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    // A plain black sky keeps attention on the data; the Sun stays as a cue for day and night.
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.moon) scene.moon.show = false;

    if (config.keys.cesiumIon) {
      // No vertex normals: with them Cesium shades terrain by the Sun at every distance, so a city
      // at night is black. Without, day and night show from space and fade to daylight up close.
      // No water mask either: its animated waves look synthetic over real imagery of the water.
      scene.setTerrain(new Terrain(createWorldTerrainAsync()));
    }
    const camera = scene.camera;
    const controller = scene.screenSpaceCameraController;
    // Stop a little above the ground (or a roof) rather than at it.
    controller.minimumZoomDistance = 2;
    // As far out as `Navigator` zooms (touch pinch is Cesium's).
    controller.maximumZoomDistance = 70_000_000;
    controller.enableCollisionDetection = true;
    // Cesium keeps dragging (pan) and touch. The wheel and trackpad are `Navigator`'s. Right-drag,
    // and drag with shift, option or ctrl, orbit the center of the screen (heading and tilt), as on
    // most maps; Cesium's own right-drag zoom and shift-drag free look would surprise.
    controller.zoomEventTypes = [CameraEventType.PINCH];
    controller.tiltEventTypes = [
      CameraEventType.MIDDLE_DRAG,
      CameraEventType.RIGHT_DRAG,
      CameraEventType.PINCH,
      { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
      { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.SHIFT },
      { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.ALT },
      { eventType: CameraEventType.RIGHT_DRAG, modifier: KeyboardEventModifier.CTRL },
    ];
    controller.lookEventTypes = undefined;
    // Data for a new view loads once the camera has held still this long (Cesium waits 500 ms; the
    // setting is public at runtime but missing from Cesium's typings).
    (scene as Scene & { cameraEventWaitTime: number }).cameraEventWaitTime = 300;

    // Natural Earth (bundled with Cesium, geographic) under everything: the GIBS layers are
    // Web Mercator, which stops at 85°, so this is what shows at the poles.
    const naturalEarth = ImageryLayer.fromProviderAsync(
      TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')),
      { dayAlpha: 1, nightAlpha: 0.35 },
    );
    globe.imageryLayers.add(naturalEarth);
    this.satelliteImagery.push(naturalEarth);
    // Blue Marble on the day side, VIIRS night lights on the night side.
    this.day = ImageryLayer.fromProviderAsync(
      Promise.resolve(gibs('BlueMarble_ShadedRelief_Bathymetry', { level: 8, format: 'jpg' })),
      { dayAlpha: 1, nightAlpha: 0 },
    );
    this.night = ImageryLayer.fromProviderAsync(
      Promise.resolve(gibs('VIIRS_Black_Marble', { level: 8, format: 'png' })),
      { dayAlpha: 0, nightAlpha: 1, brightness: 1.4 },
    );
    globe.imageryLayers.add(this.day);
    globe.imageryLayers.add(this.night);
    this.satelliteImagery.push(this.day, this.night);
    // Cloudless Sentinel-2 mosaic for the regional scale.
    const sentinel = new ImageryLayer(
      new UrlTemplateImageryProvider({
        url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
        tilingScheme: new WebMercatorTilingScheme(),
        maximumLevel: 15,
        credit: new Credit(
          '<a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX</a> (Copernicus Sentinel data 2024)',
        ),
      }),
      { minimumTerrainLevel: SENTINEL_FROM_LEVEL },
    );
    globe.imageryLayers.add(sentinel);
    this.satelliteImagery.push(sentinel);
    // Esri's sub-meter imagery for cities, when this deployment has an ArcGIS key.
    if (config.keys.arcgis) {
      ArcGisMapService.defaultAccessToken = config.keys.arcgis;
      const esri = ImageryLayer.fromProviderAsync(
        ArcGisMapServerImageryProvider.fromBasemapType(ArcGisBaseMapType.SATELLITE),
        { minimumTerrainLevel: ESRI_FROM_LEVEL },
      );
      globe.imageryLayers.add(esri);
      this.satelliteImagery.push(esri);
    }
    this.reference = [
      ImageryLayer.fromProviderAsync(
        Promise.resolve(gibs('Reference_Features_15m', { level: 13, format: 'png' })),
        { alpha: 0.55, maximumTerrainLevel: REFERENCE_UNTIL_LEVEL },
      ),
      ImageryLayer.fromProviderAsync(
        Promise.resolve(gibs('Reference_Labels_15m', { level: 13, format: 'png' })),
        { alpha: 0.85, maximumTerrainLevel: REFERENCE_UNTIL_LEVEL },
      ),
    ];

    const clock = this.widget.clock;
    clock.clockStep = ClockStep.SYSTEM_CLOCK;
    clock.currentTime = JulianDate.now();
    clock.shouldAnimate = true;

    // Start over the viewer's own longitude, guessed from their UTC offset (no permission needed).
    const lon = CesiumMath.clamp(-new Date().getTimezoneOffset() / 4, -180, 180);
    camera.setView({ destination: Cartesian3.fromDegrees(lon, 22, 21_000_000) });

    // 3D buildings and tiles are lit by `scene.light`. The Sun leaves a city at night as black
    // boxes, so near the ground the light comes from the viewer instead. The globe's own day and
    // night shading has faded out by then, so this only changes how models read.
    const sun = new SunLight();
    const flashlight = new DirectionalLight({ direction: Cartesian3.clone(camera.directionWC) });
    this.cleanup.push(
      scene.preRender.addEventListener(() => {
        const near = camera.positionCartographic.height < VIEWER_LIGHT_BELOW;
        if (near) {
          Cartesian3.clone(camera.directionWC, flashlight.direction);
          scene.light = flashlight;
        } else if (scene.light !== sun) scene.light = sun;
      }),
    );

    camera.percentageChanged = 0.02;
    this.cleanup.push(
      camera.changed.addEventListener(() => {
        this.currentView = this.measureView();
        this.viewChanged.emit(this.currentView);
      }),
      camera.moveEnd.addEventListener(() => {
        this.currentView = this.measureView();
        this.viewSettled.emit(this.currentView);
        // The view moved under a resting pointer: what it's over has changed.
        this.scheduleHover();
      }),
      scene.preRender.addEventListener(() => this.updateFollow()),
    );
    this.currentView = this.measureView();

    this.navigation = new Navigator(this);
    this.cleanup.push(() => this.navigation.destroy());

    // Occlusion. Cesium's default skips depth-testing points against terrain (so the ground they
    // sit on doesn't clip them) and hides what's behind the Earth with a plane at the horizon, which
    // fails near the ground over real terrain: satellites and far-off markers showed through the
    // Earth from street level. Instead, terrain occludes, and everything nearer than the horizon
    // skips the test: nothing nearer than the horizon can be behind the Earth. The distance is the
    // scene's default for every point, billboard and label, set each frame after the camera has
    // moved (so a fast zoom never draws the far side through the Earth).
    globe.depthTestAgainstTerrain = true;
    this.cleanup.push(
      scene.preRender.addEventListener(() => {
        scene.minimumDisableDepthTestDistance = horizonDistance(camera.positionCartographic.height);
      }),
    );

    this.handler = new ScreenSpaceEventHandler(scene.canvas);
    this.listenForPointer();
    this.throttleWhenIdle();
  }

  /**
   * Keeps the drawing buffer at `pixelRatio` (Cesium multiplies its
   * resolution scale by the window's density, which changes when the window
   * moves to another screen).
   */
  private keepPixelRatio(): void {
    let query: MediaQueryList | undefined;
    const apply = () => {
      const density = window.devicePixelRatio || 1;
      this.widget.resolutionScale = this.pixelRatio / density;
      query?.removeEventListener('change', apply);
      query = window.matchMedia(`(resolution: ${density}dppx)`);
      query.addEventListener('change', apply);
    };
    apply();
    this.cleanup.push(() => query?.removeEventListener('change', apply));
  }

  /**
   * Draws at full rate while anything moves, loads or is being used, and at
   * `IDLE_FRAME_RATE` otherwise: a still globe at 120 Hz only spends the
   * battery. Input wakes it before its next frame.
   */
  private throttleWhenIdle(): void {
    const { scene } = this;
    const camera = scene.camera;
    // Undefined means every frame; Cesium's typings only allow a number.
    const widget = this.widget as { targetFrameRate: number | undefined };
    const lastView = new Matrix4();
    const wake = () => {
      this.lastActivity = performance.now();
      if (widget.targetFrameRate !== undefined) widget.targetFrameRate = undefined;
    };
    // Pointer moves only over the globe: hovering the panels changes nothing drawn.
    const events = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;
    for (const type of events) window.addEventListener(type, wake, { capture: true, passive: true });
    scene.canvas.addEventListener('pointermove', wake, { passive: true });
    this.cleanup.push(
      () => {
        for (const type of events) window.removeEventListener(type, wake, { capture: true });
        scene.canvas.removeEventListener('pointermove', wake);
      },
      scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
        this.tilesLoading = queued > 0;
      }),
      scene.postRender.addEventListener(() => {
        const now = performance.now();
        if (!Matrix4.equals(camera.viewMatrix, lastView)) {
          Matrix4.clone(camera.viewMatrix, lastView);
          this.lastMotion = now;
        }
        const loading =
          (this.tilesLoading && scene.globe.show) ||
          (this.photoreal?.show === true && !this.photoreal.tilesLoaded);
        const idle =
          !loading &&
          !this.navigation.busy &&
          now - Math.max(this.lastMotion, this.lastActivity, this.navigation.lastInput) > IDLE_AFTER_MS;
        const target = idle ? IDLE_FRAME_RATE : undefined;
        if (widget.targetFrameRate !== target) widget.targetFrameRate = target;
      }),
    );
  }

  /**
   * Clicks pick right away. Hover picks wait for the pointer to rest over a
   * still globe: each one renders the scene again and stalls the GPU, which
   * during a drag or zoom costs frames, and what's under the pointer is
   * changing anyway. When the view settles, the pointer is picked again.
   */
  private listenForPointer(): void {
    const canvas = this.scene.canvas;
    this.handler.setInputAction(
      (event: { position: Cartesian2 }) => this.clicked.emit(this.pickAt(event.position)),
      ScreenSpaceEventType.LEFT_CLICK,
    );
    this.handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      this.pointer = { x: event.endPosition.x, y: event.endPosition.y };
      this.scheduleHover();
    }, ScreenSpaceEventType.MOUSE_MOVE);
    const press = (event: PointerEvent) => {
      this.pressed = event.buttons !== 0;
      // A drag that held still before letting go has already settled: look again now it's released.
      if (!this.pressed) this.scheduleHover();
    };
    const leave = () => {
      this.pointer = undefined;
      clearTimeout(this.hoverTimer);
      this.hovered.emit({ pick: { kind: 'none' }, x: 0, y: 0 });
    };
    canvas.addEventListener('pointerdown', press);
    window.addEventListener('pointerup', press);
    canvas.addEventListener('pointerleave', leave);
    this.cleanup.push(() => {
      clearTimeout(this.hoverTimer);
      canvas.removeEventListener('pointerdown', press);
      window.removeEventListener('pointerup', press);
      canvas.removeEventListener('pointerleave', leave);
    });
  }

  private scheduleHover(): void {
    clearTimeout(this.hoverTimer);
    const pointer = this.pointer;
    if (!pointer) return;
    const canvas = this.scene.canvas;
    const now = performance.now();
    const wait = Math.max(
      this.lastHover + HOVER_INTERVAL_MS - now,
      this.lastMotion + HOVER_SETTLE_MS - now,
      this.navigation.lastInput + HOVER_SETTLE_MS - now,
      0,
    );
    this.hoverTimer = setTimeout(() => {
      if (this.pressed || this.navigation.busy || this.isolated) return;
      // Still moving: try again once it holds still (moveEnd also re-schedules).
      if (performance.now() - this.lastMotion < HOVER_SETTLE_MS) {
        this.scheduleHover();
        return;
      }
      this.lastHover = performance.now();
      const rect = canvas.getBoundingClientRect();
      const pick = this.pickAt(new Cartesian2(pointer.x, pointer.y), false);
      this.hovered.emit({ pick, x: rect.left + pointer.x, y: rect.top + pointer.y });
    }, wait);
  }

  /** Current simulation time, epoch ms. Live by default. */
  now(): number {
    return JulianDate.toDate(this.widget.clock.currentTime).getTime();
  }

  get view(): View {
    return this.currentView;
  }

  get basemap(): Basemap {
    return this.currentBasemap;
  }

  /** Whether Photorealistic 3D is possible here (it comes through Cesium ion). */
  get canPhotoreal(): boolean {
    return this.config.keys.cesiumIon !== null;
  }

  /** Switches the base map; layers that can't be shown on it are hidden by their owner (`World`). */
  async setBasemap(basemap: Basemap): Promise<void> {
    if (basemap === this.currentBasemap) return;
    if (basemap === 'photoreal' && !this.canPhotoreal) return;
    this.currentBasemap = basemap;
    const photoreal = basemap === 'photoreal';
    // Google's tiles carry their own terrain and imagery: the globe would only show through gaps.
    this.scene.globe.show = !photoreal;
    for (const layer of this.satelliteImagery) layer.show = !photoreal;
    if (photoreal) {
      const tileset = await this.loadPhotoreal();
      if (tileset && this.currentBasemap === 'photoreal') tileset.show = true;
    } else if (this.photoreal) {
      this.photoreal.show = false;
    }
    this.basemapChanged.emit(basemap);
  }

  private loadPhotoreal(): Promise<Cesium3DTileset | undefined> {
    this.photorealLoading ??= createGooglePhotorealistic3DTileset(
      // Place search uses Google's geocoder while this base map is on (see the search dialog).
      { onlyUsingWithGoogleGeocoder: true },
      // Cesium turns collision on for these tiles by default. With it, every marker clamped to the
      // ground is ray-cast against tile geometry read back from the GPU (seconds per frame while a
      // city streams in); markers get terrain heights instead (`followGround`).
      { showCreditsOnScreen: true, maximumScreenSpaceError: 8, enableCollision: false },
    )
      .then((tileset) => {
        this.photoreal = this.scene.primitives.add(tileset);
        return tileset;
      })
      .catch((error: unknown) => {
        console.error('Photorealistic 3D tiles unavailable', error);
        this.photorealLoading = undefined;
        return undefined;
      });
    return this.photorealLoading;
  }

  /** Adds `layer` to the imagery stack, above the base map and below the reference overlay. */
  addImagery(layer: ImageryLayer): void {
    const layers = this.scene.globe.imageryLayers;
    const firstReference = this.reference.map((r) => layers.indexOf(r)).filter((i) => i >= 0);
    layers.add(layer, firstReference.length > 0 ? Math.min(...firstReference) : undefined);
  }

  removeImagery(layer: ImageryLayer): void {
    this.scene.globe.imageryLayers.remove(layer, true);
  }

  setReference(visible: boolean): void {
    const layers = this.scene.globe.imageryLayers;
    for (const layer of this.reference) {
      if (visible && !layers.contains(layer)) layers.add(layer);
      if (!visible && layers.contains(layer)) layers.remove(layer, false);
    }
  }

  /**
   * Hides the globe and everything drawn on it, for a panorama that surrounds
   * the camera (anything inside the sphere would show through it). Primitives
   * added afterwards show normally. Returns the undo.
   */
  isolate(): () => void {
    const { scene } = this;
    this.isolated = true;
    const hidden: Array<{ show: boolean; isDestroyed?: () => boolean }> = [];
    for (let i = 0; i < scene.primitives.length; i++) {
      const primitive = scene.primitives.get(i) as { show: boolean; isDestroyed?: () => boolean };
      if (primitive.show) {
        primitive.show = false;
        hidden.push(primitive);
      }
    }
    const globeShown = scene.globe.show;
    scene.globe.show = false;
    return () => {
      this.isolated = false;
      for (const primitive of hidden) if (!primitive.isDestroyed?.()) primitive.show = true;
      scene.globe.show = globeShown;
    };
  }

  /** Real day and night, or the whole Earth in daylight. */
  setLighting(enabled: boolean): void {
    this.scene.globe.enableLighting = enabled;
    this.night.show = enabled;
  }

  /**
   * Ground height (meters above the ellipsoid) at a point, from what's loaded:
   * terrain on the satellite base map, the 3D tiles on Photorealistic. Undefined
   * when nothing is loaded there yet.
   */
  heightAt(lon: number, lat: number): number | undefined {
    // Hidden (inside a panorama, or under Photorealistic 3D), the globe can't answer.
    if (this.isolated || !this.scene.globe.show) return undefined;
    return plausible(this.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat)));
  }

  /**
   * Ground heights for many points at once: from the loaded terrain, or with
   * the globe hidden under Photorealistic 3D, sampled from the terrain data
   * (Google's tiles sit on the same ground). Sampling the tiles themselves
   * would render the scene once per point.
   */
  async groundHeights(
    points: ReadonlyArray<{ readonly lon: number; readonly lat: number }>,
  ): Promise<Array<number | undefined>> {
    if (this.isolated || points.length === 0) return points.map(() => undefined);
    if (this.scene.globe.show) return points.map((p) => this.heightAt(p.lon, p.lat));
    const sampled = await sampleTerrain(
      this.scene.terrainProvider,
      TERRAIN_SAMPLE_LEVEL,
      points.map((p) => Cartographic.fromDegrees(p.lon, p.lat)),
    ).catch(() => []);
    return points.map((_, i) => plausible(sampled[i]?.height));
  }

  /** Lets a layer resolve picks of things it can't tag with a `PickId` (3D tile features). */
  addPicker(picker: Picker): () => void {
    this.pickers.add(picker);
    return () => this.pickers.delete(picker);
  }

  pickAt(position: Cartesian2, includePlaces = true): Pick {
    const picked: unknown = this.scene.pick(position, 4, 4);
    if (defined(picked)) {
      const id = (picked as { id?: unknown }).id;
      if (isPickId(id)) return { kind: 'entity', layer: id.layer, key: id.key };
      for (const picker of this.pickers) {
        const resolved = picker(picked);
        if (resolved) return { kind: 'entity', ...resolved };
      }
    }
    if (!includePlaces) return { kind: 'none' };
    const point = this.surfaceAt(position);
    if (!point) return { kind: 'none' };
    const c = Cartographic.fromCartesian(point);
    return { kind: 'place', lat: CesiumMath.toDegrees(c.latitude), lon: CesiumMath.toDegrees(c.longitude) };
  }

  /** The point on the surface (terrain or 3D tiles) under a screen position. */
  surfaceAt(position: Cartesian2): Cartesian3 | undefined {
    const { scene } = this;
    if (this.currentBasemap === 'photoreal' && scene.pickPositionSupported) {
      const p = scene.pickPosition(position);
      if (defined(p)) return p;
    }
    const ray = scene.camera.getPickRay(position);
    const onTerrain = ray ? scene.globe.pick(ray, scene) : undefined;
    return onTerrain ?? scene.camera.pickEllipsoid(position, scene.globe.ellipsoid);
  }

  private measureView(): View {
    const { scene } = this;
    const camera = scene.camera;
    const rect = camera.computeViewRectangle(scene.globe.ellipsoid);
    const canvas = scene.canvas;
    const middle = camera.pickEllipsoid(
      new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      scene.globe.ellipsoid,
    );
    const center = middle ? Cartographic.fromCartesian(middle) : undefined;
    return {
      height: camera.positionCartographic.height,
      bounds: rect
        ? {
            west: CesiumMath.toDegrees(rect.west),
            south: CesiumMath.toDegrees(rect.south),
            east: CesiumMath.toDegrees(rect.east),
            north: CesiumMath.toDegrees(rect.north),
          }
        : undefined,
      center: center
        ? { lat: CesiumMath.toDegrees(center.latitude), lon: CesiumMath.toDegrees(center.longitude) }
        : undefined,
    };
  }

  /** Keeps the camera on a moving thing, letting the user orbit around it. */
  follow(position: (() => Cartesian3 | undefined) | undefined): void {
    this.following = position;
    if (!position) {
      this.scene.camera.lookAtTransform(Matrix4.IDENTITY);
      return;
    }
    const target = position();
    if (!target) return;
    const range = Math.max(150_000, Cartographic.fromCartesian(target).height * 1.2 + 400_000);
    this.scene.camera.lookAt(target, new Cartesian3(0, -range * 0.7, range * 0.7));
  }

  get isFollowing(): boolean {
    return this.following !== undefined;
  }

  /** A panorama has the scene to itself. */
  get isIsolated(): boolean {
    return this.isolated;
  }

  private updateFollow() {
    if (!this.following) return;
    const target = this.following();
    if (!target) return;
    const camera = this.scene.camera;
    // Keep the user's current orbit around the target (lookAt resets it otherwise).
    const offset = Cartesian3.clone(camera.position);
    camera.lookAt(target, offset);
  }

  /** Flies to a point: `height` meters above it. */
  flyTo(lat: number, lon: number, height = 2_500_000): void {
    this.follow(undefined);
    this.scene.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, height), duration: 1.6 });
  }

  /** Flies to show an area. */
  flyToBounds(bounds: Bounds): void {
    this.follow(undefined);
    this.scene.camera.flyTo({
      destination: Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
      duration: 1.6,
    });
  }

  destroy(): void {
    for (const dispose of this.cleanup) dispose();
    this.handler.destroy();
    this.widget.destroy();
  }
}
