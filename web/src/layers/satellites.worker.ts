/**
 * Propagates every satellite with SGP4 off the main thread. The layer sends
 * the elements once per snapshot (`init`), then asks for positions at a time
 * (`tick`); positions come back as Earth-fixed meters, NaN where SGP4 fails
 * (decayed or bad elements).
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
  readonly positions: Float64Array;
}

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
  const positions = new Float64Array(satrecs.length * 3);
  for (let i = 0; i < satrecs.length; i++) {
    const satrec = satrecs[i];
    const pv = satrec ? propagate(satrec, date) : null;
    if (!pv) {
      positions[i * 3] = Number.NaN;
      continue;
    }
    const ecf = eciToEcf(pv.position, gmst);
    positions[i * 3] = ecf.x * 1000;
    positions[i * 3 + 1] = ecf.y * 1000;
    positions[i * 3 + 2] = ecf.z * 1000;
  }
  scope.postMessage({ version, time: message.time, positions }, [positions.buffer]);
});
