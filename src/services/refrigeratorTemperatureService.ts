import { PlatformAccessory } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { TemperatureService } from './temperatureService';
import {
  extractRefrigeratorTemperature,
  getRefrigeratorComponentDisplayName,
} from '../util/samsungRefrigerator';

// Per-compartment temperature for Samsung Family Hub refrigerators.
// Standard `temperatureMeasurement` returns null on sub-components; the real
// per-zone values live in main's `samsungce.driverState` OCF blob.
export class RefrigeratorTemperatureService extends TemperatureService {
  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string,
    capabilities: string[], multiServiceAccessory: MultiServiceAccessory, name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding RefrigeratorTemperatureService to ${this.name} component "${componentId}"`);

    // Replace the standard temperatureMeasurement-only lambda with one that
    // falls back to OCF data when the standard capability returns null.
    this.statusTranslation = (status) => {
      const standardValue = status?.temperatureMeasurement?.temperature?.value;
      const standardUnit = status?.temperatureMeasurement?.temperature?.unit;

      if (standardValue !== null && standardValue !== undefined && standardUnit) {
        if (standardUnit === 'F') {
          this.unit = 'F';
          return (standardValue as number - 32) * (5 / 9);
        }
        this.unit = 'C';
        return standardValue as number;
      }

      const mainStatus = this.multiServiceAccessory.components.find(
        (c) => c.componentId === 'main',
      )?.status;
      const ocfFahrenheit = extractRefrigeratorTemperature(mainStatus, this.componentId);
      if (ocfFahrenheit !== null) {
        this.unit = 'F';
        return (ocfFahrenheit - 32) * (5 / 9);
      }

      // Suppress SensorService's 5-strike auto-removal here: a missing OCF
      // value usually means a transient firmware hiccup or a shape we don't
      // recognise yet. Better to show "No Response" indefinitely than silently
      // delete the tile — the user can disable ExposeMultiZoneRefrigerator if
      // the gap is permanent.
      this.statusFailureCount = 0;
      this.log.debug(`${this.name} component "${componentId}" has no temperature data (standard or OCF)`);
      throw('Bad Value');
    };

    // Distinguish compartments in Apple Home (e.g. "MyFridge Freezer", "MyFridge FlexZone").
    if (componentId !== 'main') {
      const label = getRefrigeratorComponentDisplayName(componentId) ?? componentId;
      this.service.setCharacteristic(platform.Characteristic.Name, `${this.name} ${label}`);
    }
  }
}
