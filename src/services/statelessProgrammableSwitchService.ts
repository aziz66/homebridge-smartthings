import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class StatelessProgrammableSwitchService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities:string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.StatelessProgrammableSwitch);
    this.log.debug(`Adding StatelessProgrammableSwitchService to ${this.name}`);

    // ProgrammableSwitchEvent is event-only: HAP answers every read with null (hap-nodejs ignores
    // any onGet handler for it) and treats every updateCharacteristic() as a fresh button press.
    // So it is never polled - replaying the last reported button value each poll produced phantom
    // presses. Presses are delivered from webhook events only (processEvent).
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'button') {
      if (event.attribute !== undefined && event.attribute !== 'button') {
        return;   // e.g. numberOfButtons / supportedButtonValues
      }
      this.log.debug(`Event updating button capability for ${this.name} to ${event.value}`);
      const characteristicValue = this.mapValue(event.value);
      if (characteristicValue !== undefined) {
        this.service.updateCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent, characteristicValue);
      } else {
        this.log.debug(`Ignoring unsupported button value for ${this.name}: ${event.value}`);
      }
    }
  }

  private mapValue(inboundValue: unknown) : CharacteristicValue|undefined {
    if (typeof inboundValue !== 'string') {
      return undefined;
    }
    switch (inboundValue) {
      case 'pushed':
      case 'down' :
        return(this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
      case 'double':
        return(this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
      case 'held':
        return(this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
      default:
        if (inboundValue.endsWith('_hold')) {         // down_hold, up_hold, ...
          return(this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
        }
        if (/^(pushed|down)_\d+x$/.test(inboundValue)) { // pushed_2x, down_3x, ... (HomeKit has no triple press)
          return(this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
        }
        return undefined;
    }
  }
}
