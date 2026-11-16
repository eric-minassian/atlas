import { Storage } from '@ericminassian/platform';
import { Context, Effect, Layer } from 'effect';
import type { ScheduledFeedId } from '../domain.ts';
import { makeAirportSource } from './airports.ts';
import { makeAirQualitySource } from './airquality.ts';
import { makeAuroraSource } from './aurora.ts';
import { makeBikeSystemSource } from './bike-systems.ts';
import { makeBuoySource } from './buoys.ts';
import { makeCameraSource } from './cameras.ts';
import { makeDisasterSource } from './disasters.ts';
import { makeEarthquakeSource } from './earthquakes.ts';
import { makeEventSource } from './events.ts';
import { makeFireSource } from './fires.ts';
import { makeLightningSource } from './lightning.ts';
import { makeMetarSource } from './metars.ts';
import { makePerimeterSource } from './perimeters.ts';
import { makeRadarSource } from './radar.ts';
import { makeRiverSource } from './rivers.ts';
import { makeSatelliteSource } from './satellites.ts';
import type { Source } from './source.ts';
import { makeTransitFeedSource } from './transit-feeds.ts';
import { makeTsunamiSource } from './tsunamis.ts';
import { makeVolcanoSource } from './volcanoes.ts';
import { makeWeatherAlertSource } from './weatheralerts.ts';

export type { IngestResult, Source, Validators } from './source.ts';
export { IngestError } from './source.ts';

/**
 * Every scheduled feed's source. Adding a dataset: add its id and payload
 * schema to src/domain.ts, its metadata to src/catalog.ts, a source module
 * here, and a layer in web/src/layers. A source that pushes (a WebSocket) needs
 * a service instead, like ships (src/ships.ts).
 */
export class Sources extends Context.Service<Sources, { readonly [F in ScheduledFeedId]: Source<F> }>()(
  'atlas/ingest/Sources',
) {
  // Storage: sources that cache static reference data (NWS zone outlines) keep it in `snapshots`.
  static readonly layer = Layer.effect(
    Sources,
    Effect.gen(function* () {
      const snapshots = (yield* Storage).store('snapshots');
      return Sources.of({
        satellites: makeSatelliteSource(),
        earthquakes: makeEarthquakeSource(),
        fires: makeFireSource(),
        events: makeEventSource(),
        radar: makeRadarSource(),
        metars: makeMetarSource(),
        buoys: makeBuoySource(),
        airQuality: makeAirQualitySource(),
        disasters: makeDisasterSource(),
        tsunamis: makeTsunamiSource(),
        weatherAlerts: makeWeatherAlertSource(snapshots),
        firePerimeters: makePerimeterSource(),
        volcanoes: makeVolcanoSource(),
        aurora: makeAuroraSource(),
        rivers: makeRiverSource(),
        airports: makeAirportSource(),
        transitFeeds: makeTransitFeedSource(),
        bikeSystems: makeBikeSystemSource(),
        lightning: makeLightningSource(),
        cameras: makeCameraSource(),
      });
    }),
  );
}
