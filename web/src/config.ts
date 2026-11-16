import type { ClientConfig } from '../../src/domain.ts';
import { callApi } from './client.ts';

/** Without the API (offline, or an old deployment), the globe still runs: just without keyed services. */
const NONE: ClientConfig = {
  keys: { cesiumIon: null, arcgis: null, mapillary: null },
  sources: { aisstream: false, windy: false },
};

let pending: Promise<ClientConfig> | undefined;

/** This deployment's keys and configured sources, fetched once per page. */
export const loadConfig = (): Promise<ClientConfig> => {
  pending ??= callApi((api) => api.config()).catch((error: unknown) => {
    console.warn('config unavailable; keyed layers are off', error);
    return NONE;
  });
  return pending;
};
