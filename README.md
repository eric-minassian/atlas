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

Aircraft refresh every 15 minutes on OpenSky's anonymous quota. With an
[OpenSky API client](https://opensky-network.org/my-opensky/account) they refresh every 90 seconds:

```sh
plat secrets set OPENSKY_CLIENT_ID --shared
plat secrets set OPENSKY_CLIENT_SECRET --shared
```
