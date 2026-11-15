import { Platform, toFetchHandler } from '@ericminassian/platform';
import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { HttpLive } from './http.ts';

// The web server: `plat` runs this behind the platform's wrapper, which adds
// request telemetry and traces.
export default toFetchHandler(HttpLive.pipe(Layer.provide([Platform.layer, FetchHttpClient.layer])));
