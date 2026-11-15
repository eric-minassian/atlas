# Atlas

A live model of the world on one globe: aircraft, satellites, earthquakes, fire detections, natural
events, clouds and weather radar, refreshed continuously from public sources. It runs on
[the platform](https://github.com/eric-minassian/platform) at https://atlas.ericminassian.com.

```sh
pnpm install
pnpm dev                  # http://atlas.localhost:3000 on the AWS Emulator
plat dev run-cron tick    # refresh every feed now instead of waiting for the minute
pnpm test                 # unit tests; `pnpm test:integration` (emulator), `pnpm test:e2e` (browser)
pnpm lint && pnpm format:check
```
