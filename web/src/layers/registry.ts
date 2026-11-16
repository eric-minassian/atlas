import { streetLevelLayer } from '../street/coverage.ts';
import { aircraftLayer } from './aircraft.ts';
import { airportLayer } from './airports.ts';
import { airQualityLayer } from './airquality.ts';
import { auroraLayer } from './aurora.ts';
import { bikeLayer } from './bikes.ts';
import { buildingsLayer } from './buildings.ts';
import { buoyLayer } from './buoys.ts';
import { disasterLayer } from './disasters.ts';
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
import { metarLayer } from './metars.ts';
import { perimeterLayer } from './perimeters.ts';
import { poiLayer } from './poi.ts';
import { riverLayer } from './rivers.ts';
import { roadsLayer } from './roads.ts';
import { satelliteLayer } from './satellites.ts';
import { shipLayer } from './ships.ts';
import { transitLayer } from './transit.ts';
import type { LayerDef } from './types.ts';
import { volcanoLayer } from './volcanoes.ts';
import { weatherAlertLayer } from './weatheralerts.ts';

/** Every layer, in panel order within each category. Adding a dataset ends here. */
export const layers: ReadonlyArray<LayerDef> = [
  aircraftLayer,
  airportLayer,
  shipLayer,
  buoyLayer,
  satelliteLayer,
  auroraLayer,
  earthquakeLayer,
  eventLayer,
  disasterLayer,
  weatherAlertLayer,
  fireLayer,
  perimeterLayer,
  volcanoLayer,
  riverLayer,
  cloudLayer,
  radarLayer,
  precipitationLayer,
  lightningLayer,
  metarLayer,
  airQualityLayer,
  seaTemperatureLayer,
  trueColorLayer,
  transitLayer,
  bikeLayer,
  poiLayer,
  streetLevelLayer,
  dayNightLayer,
  referenceLayer,
  roadsLayer,
  buildingsLayer,
];

export const layerById = new Map(layers.map((l) => [l.id, l]));
