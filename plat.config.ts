import { defineApp, queue } from '@ericminassian/platform/config';
import type { RefreshJob } from './src/domain.ts';

// Atlas pulls public datasets on a schedule and serves them as snapshots.
// `tick` runs every minute and queues a `refresh` for each feed that is due;
// each refresh runs on its own, so a slow or failing source never holds up the
// others. Ship positions arrive as a stream instead: the `ships` service holds
// the connection and publishes a snapshot every minute. Snapshots are files in
// the public `feeds` store, which browsers read from the edge; the db keeps
// each feed's state (current version, last success, errors).
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
  storage: {
    // Snapshots, under keys that never change (`<feed>/<version>.json`).
    feeds: { public: true },
    // The worker's own caches of reference data (NWS zone outlines).
    snapshots: {},
  },
  // Keys for sources that need an account. Browser-side keys (ion, ArcGIS, Mapillary) are
  // restricted by referrer at the provider and reach the page through `/api/config`; the
  // rest stay on the server. A source whose key isn't set is left out rather than failing.
  secrets: ['CESIUM_ION_TOKEN', 'ARCGIS_API_KEY', 'MAPILLARY_TOKEN', 'AISSTREAM_KEY', 'WINDY_WEBCAMS_KEY'],
  // One attempt each: a refresh records a failing source itself, and the next tick tries
  // again, so a platform retry would only race the next refresh of the same feed.
  queues: { refresh: queue<RefreshJob>({ maxAttempts: 1 }) },
  crons: { tick: { schedule: 'rate(1 minute)', maxAttempts: 1 } },
  // aisstream.io allows 3 connections per key, shared by every stage: prod holds one,
  // and previews hold one for the first 30 minutes after each deploy.
  services: { ships: { entry: 'src/ships.ts' } },
});

export default app;

declare module '@ericminassian/platform/config' {
  interface Register {
    app: typeof app;
  }
}
