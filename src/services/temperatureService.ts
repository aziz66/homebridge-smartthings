import { PlatformAccessory } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { SensorService } from './sensorService';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class TemperatureService extends SensorService {
  protected unit = 'F';

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding TemperatureService to ${this.name}`);

    this.initService(platform.Service.TemperatureSensor, platform.Characteristic.CurrentTemperature, (status) => {
      if (status.temperatureMeasurement.temperature.value === null || status.temperatureMeasurement.temperature.value === undefined ||
        status.temperatureMeasurement.temperature.unit === null || status.temperatureMeasurement.temperature.value === undefined) {
        this.log.warn(`${this.name} returned bad value for status`);
        throw('Bad Value');
      }
      if (status.temperatureMeasurement.temperature.unit === 'F') {
        this.log.debug('Converting temp to celcius');
        this.unit = 'F';
        return (status.temperatureMeasurement.temperature.value as number -  32) * (5/9) ; // Convert to Celcius
      } else {
        this.unit = 'C';
        return status.temperatureMeasurement.temperature.value;
      }
    });
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Event updating temperature measurement for ${this.name} to ${event.value}`);
    if (typeof event.value !== 'number' || !Number.isFinite(event.value)) {
      // A null reading would otherwise be pushed as -17.8 °C
      this.log.debug(`Ignoring non-numeric temperature event for ${this.name}`);
      return;
    }
    // Prefer the unit carried by the event, then the cached status, then the last unit learned from a read:
    // with PollSensorsSeconds 0 no read may have happened yet, and the 'F' default would turn 22 °C into -5.6 °C.
    const eventUnit = (event as { unit?: string }).unit;
    const statusUnit = this.deviceStatus?.status?.temperatureMeasurement?.temperature?.unit;
    const unit = [eventUnit, statusUnit].find(u => u === 'C' || u === 'F') ?? this.unit;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      unit === 'F' ? (event.value - 32) * (5/9) : event.value);
  }
}