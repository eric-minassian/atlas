import {
  ArcGisBaseMapType,
  ArcGisMapServerImageryProvider,
  ArcGisMapService,
  buildModuleUrl,
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
  Math as CesiumMath,
  Matrix4,
  Rectangle,
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
  private currentView: View = { height: Number.POSITIVE_INFINITY, bounds: undefined, center: undefined };
  private currentBasemap: Basemap = 'satellite';
  private readonly day: ImageryLayer;
  private readonly night: ImageryLayer;
  private readonly satelliteImagery: ImageryLayer[] = [];
  private readonly reference: ImageryLayer[];
  private photoreal: Cesium3DTileset | undefined;
  private photorealLoading: Promise<Cesium3DTileset | undefined> | undefined;
  private readonly pickers = new Set<Picker>();
  private readonly handler: ScreenSpaceEventHandler;
  private following: (() => Cartesian3 | undefined) | undefined;
  private readonly cleanup: Array<() => void> = [];

  constructor(container: HTMLElement, config: ClientConfig, creditContainer: HTMLElement) {
    this.config = config;
    if (config.keys.cesiumIon) Ion.defaultAccessToken = config.keys.cesiumIon;
    this.widget = new CesiumWidget(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      scene3DOnly: true,
      msaaSamples: 4,
      creditContainer,
    });
    this.scene = this.widget.scene;
    const { scene } = this;
    const globe = scene.globe;

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
    controller.enableCollisionDetection = true;

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
      }),
      scene.preRender.addEventListener(() => this.updateFollow()),
    );
    this.currentView = this.measureView();

    this.handler = new ScreenSpaceEventHandler(scene.canvas);
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
      { showCreditsOnScreen: true, enableCollision: true, maximumScreenSpaceError: 8 },
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
    const c = Cartographic.fromDegrees(lon, lat);
    if (this.currentBasemap === 'photoreal')
      return this.scene.sampleHeightSupported ? this.scene.sampleHeight(c) : undefined;
    return this.scene.globe.getHeight(c);
  }

  /** Lets a layer resolve picks of things it can't tag with a `PickId` (3D tile features). */
  addPicker(picker: Picker): () => void {
    this.pickers.add(picker);
    return () => this.pickers.delete(picker);
  }

  /** Calls `onPick` for clicks, and `onHover` (throttled) as the pointer moves. */
  onPointer(onPick: (pick: Pick) => void, onHover: (pick: Pick) => void): void {
    this.handler.setInputAction(
      (event: { position: Cartesian2 }) => onPick(this.pickAt(event.position)),
      ScreenSpaceEventType.LEFT_CLICK,
    );
    let last = 0;
    this.handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      const now = performance.now();
      if (now - last < 80) return;
      last = now;
      onHover(this.pickAt(event.endPosition, false));
    }, ScreenSpaceEventType.MOUSE_MOVE);
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
