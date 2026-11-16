import { aircraftLayer } from './aircraft.ts';
import { airportLayer } from './airports.ts';
import { bikeLayer } from './bikes.ts';
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
import { lightningLayer } from './lightning.ts';
import { satelliteLayer } from './satellites.ts';
import { shipLayer } from './ships.ts';
import { transitLayer } from './transit.ts';
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
  dayNightLayer,
  referenceLayer,
  shipLayer,
  airportLayer,
  transitLayer,
  bikeLayer,
  lightningLayer,
];

export const layerById = new Map(layers.map((l) => [l.id, l]));
