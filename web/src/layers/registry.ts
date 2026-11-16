import { aircraftLayer } from './aircraft.ts';
import { buildingsLayer } from './buildings.ts';
import { earthquakeLayer } from './earthquakes.ts';
import { eventLayer } from './events.ts';
import { fireLayer } from './fires.ts';
import {
  cloudLayer,
  dayNightLayer,
  precipitationLayer,
  radarLayer,
  referenceLayer,
  seaTemperatureLayer,
  trueColorLayer,
} from './imagery.ts';
import { poiLayer } from './poi.ts';
import { roadsLayer } from './roads.ts';
import { satelliteLayer } from './satellites.ts';
import type { LayerDef } from './types.ts';

/** Every layer, in panel order within each category. Adding a dataset ends here. */
export const layers: ReadonlyArray<LayerDef> = [
  aircraftLayer,
  satelliteLayer,
  earthquakeLayer,
  eventLayer,
  fireLayer,
  seaTemperatureLayer,
  trueColorLayer,
  cloudLayer,
  radarLayer,
  precipitationLayer,
  poiLayer,
  dayNightLayer,
  referenceLayer,
  roadsLayer,
  buildingsLayer,
];

export const layerById = new Map(layers.map((l) => [l.id, l]));
