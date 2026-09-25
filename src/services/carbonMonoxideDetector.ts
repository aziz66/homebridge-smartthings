import { PlatformAccessory } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { SensorService } from './sensorService';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class CarbonMonoxideDetectorService extends SensorService {
  serviceName = 'CarbonMonixideDetector';

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {

    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.initService(platform.Service.CarbonMonoxideSensor,
      platform.Characteristic.CarbonMonoxideDetected,
      (status) => {
        const deviceStatus = status.carbonMonoxideDetector.carbonMonoxide.value;
        if (deviceStatus === null || deviceStatus === undefined) {
          this.log.warn(`${this.name} returned bad value for status`);
          throw('Bad Value');
        }
        return deviceStatus === 'detected' ?
          this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL :
          this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
      });

    // processEvent used to update CarbonDioxideDetected here, which made hap-nodejs add that
    // characteristic to the CO tile; it persists in the accessory cache, so drop it.
    const stray = this.service.characteristics.find(c => c.UUID === this.platform.Characteristic.CarbonDioxideDetected.UUID);
    if (stray) {
      this.service.removeCharacteristic(stray);
      this.log.debug(`Removed stray CarbonDioxideDetected characteristic from ${this.name}`);
    }

    this.log.debug(`Adding ${this.serviceName} Service to ${this.name}`);
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Event updating CO detection for ${this.name} to ${event.value}`);
    this.service.updateCharacteristic(this.platform.Characteristic.CarbonMonoxideDetected,
      (event.value === 'detected' ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL :
        this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL) );
  }
}