import { Context, Layer } from 'effect';
import type { FeedId } from '../domain.ts';
import { makeEarthquakeSource } from './earthquakes.ts';
import { makeEventSource } from './events.ts';
import { makeFireSource } from './fires.ts';
import { makeRadarSource } from './radar.ts';
import { makeSatelliteSource } from './satellites.ts';
import type { Source } from './source.ts';

export type { IngestResult, Source, Validators } from './source.ts';
export { IngestError } from './source.ts';

/**
 * Every feed's source. Adding a dataset: add its id and payload schema to
 * src/domain.ts, its metadata to src/catalog.ts, a source module here, and a
 * layer in web/src/layers.
 */
export class Sources extends Context.Service<Sources, { readonly [F in FeedId]: Source<F> }>()(
  'atlas/ingest/Sources',
) {
  static readonly layer = Layer.sync(Sources, () =>
    Sources.of({
      satellites: makeSatelliteSource(),
      earthquakes: makeEarthquakeSource(),
      fires: makeFireSource(),
      events: makeEventSource(),
      radar: makeRadarSource(),
    }),
  );
}
