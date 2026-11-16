import { aircraftLayer } from './aircraft.ts';
import { cameraLayer } from './cameras.ts';
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
import { photoLayer } from './photos.ts';
import { placeLayer } from './places.ts';
import { satelliteLayer } from './satellites.ts';
import type { LayerDef } from './types.ts';
import { wildlifeLayer } from './wildlife.ts';

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
  cameraLayer,
  placeLayer,
  photoLayer,
  wildlifeLayer,
];

export const layerById = new Map(layers.map((l) => [l.id, l]));
