import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class ValveService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Valve);
    // Set the event handlers
    this.log.debug(`Adding ValveService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.Active)  // Always return true for active
      .onGet(this.getValveState.bind(this))
      .onSet(this.setValveState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.ValveType).onGet(() => platform.Characteristic.ValveType.IRRIGATION);
    this.service.getCharacteristic(platform.Characteristic.InUse)
      .onGet(this.getValveState.bind(this));
  }

  // Return the current target state
  async getValveState(): Promise<number> {
    // If it has been more than 10 seconds since we've sent a transition command,
    // reset the target state to the current state.

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        const valveState = success ? this.deviceStatus.status?.valve?.valve?.value : undefined;
        if (valveState === undefined || valveState === null) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        this.log.debug(`Received valve value of ${valveState} from Smartthings`);
        resolve(valveState === 'open' ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
      }).catch(() => reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)));
    });
  }

  // Set the target state of the valve
  async setValveState(value: CharacteristicValue) {
    this.log.debug('Received setValveState(' + value + ') event for ' + this.name);

    const command = value === this.platform.Characteristic.Active.ACTIVE ? 'open' : 'close';
    if (!(await this.multiServiceAccessory.sendCommand(this.componentId, 'valve', command))) {
      this.log.error(`Command failed for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name);
    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  public processEvent(event: ShortEvent): void {
    // The switch+valve combo also routes 'switch' events here; only the valve drives the tile.
    if (event.capability !== 'valve') {
      return;
    }
    this.log.debug(`Event updating valve capability for ${this.name} to ${event.value}`);
    const state = event.value === 'open' ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
    this.service.updateCharacteristic(this.platform.Characteristic.Active, state);
    this.service.updateCharacteristic(this.platform.Characteristic.InUse, state);
  }


}
