import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

const ROBOT_COMMAND_CAPABILITY = 'samsungce.robotCleanerOperatingState';
const ROBOT_MOVEMENT_CAPABILITY = 'robotCleanerMovement';
const ROBOT_MOVEMENT_ATTRIBUTE = 'robotCleanerMovement';
// Movement values reported by SmartThings that should map to HomeKit "On".
const ACTIVE_STATES = ['cleaning', 'homing', 'moving'];

export class RobotVacuumService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Switch);
    this.log.debug(`Adding RobotVacuumService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getSwitchState.bind(this))
      .onSet(this.setSwitchState.bind(this));

    let pollSwitchesAndLightsSeconds = 10; // default to 10 seconds
    if (this.platform.config.PollSwitchesAndLightsSeconds !== undefined) {
      pollSwitchesAndLightsSeconds = this.platform.config.PollSwitchesAndLightsSeconds;
    }

    if (pollSwitchesAndLightsSeconds > 0) {
      multiServiceAccessory.startPollingState(pollSwitchesAndLightsSeconds, this.getSwitchState.bind(this), this.service,
        platform.Characteristic.On);
    }
  }

  async setSwitchState(value: CharacteristicValue) {
    this.log.debug('Received setSwitchState(' + value + ') event for ' + this.name);

    if (!this.multiServiceAccessory.isOnline) {
      this.log.error(this.name + ' is offline');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const command = value ? 'start' : 'returnToHome';
    this.multiServiceAccessory.sendCommand(this.componentId, ROBOT_COMMAND_CAPABILITY, command).then((success) => {
      if (success) {
        this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name + ' (command: ' + command + ')');
        this.multiServiceAccessory.forceNextStatusRefresh();
      } else {
        this.log.error(`Command ${command} failed for ${this.name}`);
      }
    });
  }

  async getSwitchState(): Promise<CharacteristicValue> {
    this.log.debug('Received getSwitchState() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          let movement;
          try {
            movement = this.deviceStatus.status[ROBOT_MOVEMENT_CAPABILITY][ROBOT_MOVEMENT_ATTRIBUTE].value;
          } catch (error) {
            this.log.error(`Missing robotCleanerMovement from ${this.name}`);
          }
          const isActive = ACTIVE_STATES.includes(movement);
          this.log.debug(`movement from ${this.name}: ${movement} -> HomeKit On = ${isActive}`);
          resolve(isActive);
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === ROBOT_MOVEMENT_CAPABILITY && event.attribute === ROBOT_MOVEMENT_ATTRIBUTE) {
      const isActive = ACTIVE_STATES.includes(event.value);
      this.log.debug(`Event updating movement for ${this.name} to ${event.value} -> HomeKit On = ${isActive}`);
      this.service.updateCharacteristic(this.platform.Characteristic.On, isActive);
    }
  }
}
