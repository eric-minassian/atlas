import { defineApp, queue } from '@ericminassian/platform/config';
import type { RefreshJob } from './src/domain.ts';

// Atlas pulls public datasets on a schedule and serves them as snapshots.
// `tick` runs every minute and queues a `refresh` for each feed that is due;
// each refresh runs on its own, so a slow or failing source never holds up the
// others. Snapshots live in `snapshots` storage, and the db keeps each feed's
// state (current version, last success, errors).
const app = defineApp({
  name: 'atlas',
  description: 'A live, interactive model of the world',
  web: {
    server: 'src/server.ts',
    static: 'web/dist',
    build: 'vite build --config web/vite.config.ts',
    dev: { command: 'vite --config web/vite.config.ts' },
    spa: true,
  },
  // Parsing the larger sources (fire detections are ~7 MB of CSV) needs headroom.
  worker: { timeoutSeconds: 120, memoryMb: 1024 },
  db: true,
  storage: ['snapshots'],
  // Keys for sources that need an account. Browser-side keys (ion, ArcGIS, Mapillary) are
  // restricted by referrer at the provider and reach the page through `/api/config`; the
  // rest stay on the server. A source whose key isn't set is left out rather than failing.
  secrets: ['CESIUM_ION_TOKEN', 'ARCGIS_API_KEY', 'MAPILLARY_TOKEN', 'AISSTREAM_KEY', 'WINDY_WEBCAMS_KEY'],
  queues: { refresh: queue<RefreshJob>({ batchSize: 1, maxReceiveCount: 2 }) },
  crons: { tick: 'rate(1 minute)' },
});

export default app;

declare module '@ericminassian/platform/config' {
  interface Register {
    app: typeof app;
  }
}
