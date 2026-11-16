/**
 * Propagates every satellite with SGP4 off the main thread. The layer sends
 * the elements once per snapshot (`init`), then asks for states at a time
 * (`tick`): Earth-fixed position (m) and velocity (m/s) per satellite, six
 * numbers each, NaN where SGP4 fails (decayed or bad elements). The layer
 * moves each satellite along its velocity between ticks.
 */
import { eciToEcf, gstime, propagate, type SatRec } from 'satellite.js';
import type { SatelliteData } from '../../../src/domain.ts';
import { satrecOf } from './orbits.ts';

export type WorkerRequest =
  | { readonly type: 'init'; readonly version: string; readonly data: SatelliteData }
  | { readonly type: 'tick'; readonly version: string; readonly time: number };

export interface WorkerResponse {
  readonly version: string;
  readonly time: number;
  /** x, y, z, vx, vy, vz per satellite, Earth-fixed. */
  readonly states: Float64Array;
}

/** The Earth's rotation rate, rad/s. */
const EARTH_ROTATION = 7.292115e-5;

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
};

let version = '';
let satrecs: Array<SatRec | null> = [];

scope.addEventListener('message', ({ data: message }) => {
  if (message.type === 'init') {
    version = message.version;
    satrecs = message.data.name.map((_, i) => satrecOf(message.data, i));
    return;
  }
  if (message.version !== version) return;
  const date = new Date(message.time);
  const gmst = gstime(date);
  const states = new Float64Array(satrecs.length * 6);
  for (let i = 0; i < satrecs.length; i++) {
    const satrec = satrecs[i];
    const pv = satrec ? propagate(satrec, date) : null;
    const o = i * 6;
    if (!pv) {
      states[o] = Number.NaN;
      continue;
    }
    const p = eciToEcf(pv.position, gmst);
    // Velocity in the rotating frame: the inertial one turned into it, less the frame's own turning (ω × r).
    const v = eciToEcf(pv.velocity, gmst);
    states[o] = p.x * 1000;
    states[o + 1] = p.y * 1000;
    states[o + 2] = p.z * 1000;
    states[o + 3] = (v.x + EARTH_ROTATION * p.y) * 1000;
    states[o + 4] = (v.y - EARTH_ROTATION * p.x) * 1000;
    states[o + 5] = v.z * 1000;
  }
  scope.postMessage({ version, time: message.time, states }, [states.buffer]);
});
