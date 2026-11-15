import {
  buildModuleUrl,
  Cartesian2,
  Cartesian3,
  Cartographic,
  CesiumWidget,
  ClockStep,
  Color,
  Credit,
  defined,
  EllipsoidTerrainProvider,
  ImageryLayer,
  JulianDate,
  Math as CesiumMath,
  Matrix4,
  type Scene,
  TileMapServiceImageryProvider,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
} from 'cesium';

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

export class Globe {
  readonly widget: CesiumWidget;
  readonly scene: Scene;
  private readonly day: ImageryLayer;
  private readonly night: ImageryLayer;
  private readonly reference: ImageryLayer[];
  private readonly handler: ScreenSpaceEventHandler;
  private following: (() => Cartesian3 | undefined) | undefined;
  private followOffset = new Cartesian3(0, -2_500_000, 2_500_000);
  private readonly removeFollow: () => void;

  constructor(container: HTMLElement) {
    this.widget = new CesiumWidget(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      scene3DOnly: true,
      msaaSamples: 4,
      creditContainer: document.createElement('div'),
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
    scene.backgroundColor = Color.BLACK;
    scene.highDynamicRange = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    // A plain black sky keeps attention on the data; the Sun stays as a cue for day and night.
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.moon) scene.moon.show = false;

    // Natural Earth (bundled with Cesium, geographic) under everything: the GIBS layers are
    // Web Mercator, which stops at 85°, so this is what shows at the poles.
    globe.imageryLayers.add(
      ImageryLayer.fromProviderAsync(
        TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')),
        { dayAlpha: 1, nightAlpha: 0.35 },
      ),
    );
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
    this.reference = [
      ImageryLayer.fromProviderAsync(
        Promise.resolve(gibs('Reference_Features_15m', { level: 13, format: 'png' })),
        { alpha: 0.55 },
      ),
      ImageryLayer.fromProviderAsync(
        Promise.resolve(gibs('Reference_Labels_15m', { level: 13, format: 'png' })),
        { alpha: 0.85 },
      ),
    ];

    const clock = this.widget.clock;
    clock.clockStep = ClockStep.SYSTEM_CLOCK;
    clock.currentTime = JulianDate.now();
    clock.shouldAnimate = true;

    // Start over the viewer's own longitude, guessed from their UTC offset (no permission needed).
    const lon = CesiumMath.clamp(-new Date().getTimezoneOffset() / 4, -180, 180);
    scene.camera.setView({ destination: Cartesian3.fromDegrees(lon, 22, 21_000_000) });

    this.handler = new ScreenSpaceEventHandler(scene.canvas);
    this.removeFollow = scene.preRender.addEventListener(() => this.updateFollow());
  }

  /** Current simulation time, epoch ms. Live by default. */
  now(): number {
    return JulianDate.toDate(this.widget.clock.currentTime).getTime();
  }

  /** Adds `layers` to the imagery stack, above the base map and below the reference overlay. */
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
    const picked: unknown = this.scene.pick(position, 6, 6);
    if (defined(picked)) {
      const id = (picked as { id?: unknown }).id;
      if (isPickId(id)) return { kind: 'entity', layer: id.layer, key: id.key };
    }
    if (!includePlaces) return { kind: 'none' };
    const cartesian = this.scene.camera.pickEllipsoid(position, this.scene.globe.ellipsoid);
    if (!cartesian) return { kind: 'none' };
    const c = Cartographic.fromCartesian(cartesian);
    return { kind: 'place', lat: CesiumMath.toDegrees(c.latitude), lon: CesiumMath.toDegrees(c.longitude) };
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
    this.followOffset = new Cartesian3(0, -range * 0.7, range * 0.7);
    this.scene.camera.lookAt(target, this.followOffset);
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

  destroy(): void {
    this.removeFollow();
    this.handler.destroy();
    this.widget.destroy();
  }
}
