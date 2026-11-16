import { Effect, Schema } from 'effect';
import type { RadarData } from '../domain.ts';
import { decodeJson, get, okText, type Source, updated } from './source.ts';

/** RainViewer's index of global radar composite frames (10-minute steps, about two hours back). */
const MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';

const Frame = Schema.Struct({ time: Schema.Finite, path: Schema.String });

const WeatherMaps = Schema.Struct({
  host: Schema.String,
  radar: Schema.Struct({ past: Schema.Array(Frame) }),
});
type WeatherMaps = typeof WeatherMaps.Type;

export const parseRadar = (maps: WeatherMaps): RadarData => ({
  host: maps.host,
  frames: maps.radar.past.toSorted((a, b) => a.time - b.time),
});

export const makeRadarSource = (): Source<'radar'> => ({
  read: () =>
    Effect.gen(function* () {
      const response = yield* get(MAPS_URL);
      const data = parseRadar(yield* decodeJson(WeatherMaps)(yield* okText(response)));
      return updated<'radar'>(data, data.frames.length);
    }),
});
