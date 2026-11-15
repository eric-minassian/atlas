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
  queues: { refresh: queue<RefreshJob>({ batchSize: 1, maxReceiveCount: 2 }) },
  crons: { tick: 'rate(1 minute)' },
});

export default app;

declare module '@ericminassian/platform/config' {
  interface Register {
    app: typeof app;
  }
}
