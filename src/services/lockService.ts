import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class LockService extends BaseService {
  private targetState = 0;
  private lockInTransitionStart = 0;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.LockMechanism);
    // Set the event handlers
    this.log.debug(`Adding LockService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));

    // Set Target State to current state to start
    this.getLockCurrentState().then(currentState => {
      if (currentState === platform.Characteristic.LockCurrentState.UNSECURED) {
        this.targetState = platform.Characteristic.LockTargetState.UNSECURED;
      } else {
        this.targetState = platform.Characteristic.LockTargetState.SECURED;
      }
    }).catch(() => {
      this.log.error(`Failed to get current state for ${this.name} on init`);
      this.targetState = platform.Characteristic.LockTargetState.SECURED;
    });

    let pollLocksSeconds = 10; // default to 10 seconds
    if (this.platform.config.PollLocksSeconds !== undefined) {
      pollLocksSeconds = this.platform.config.PollLocksSeconds;
    }

    if (pollLocksSeconds > 0) {
      multiServiceAccessory.startPollingState(pollLocksSeconds, this.getLockCurrentState.bind(this), this.service,
        platform.Characteristic.LockCurrentState,
        this.platform.Characteristic.LockTargetState, this.getLockTargetState.bind(this));
    }
  }

  // Return the current target state
  async getLockTargetState(): Promise<number> {
    // If it has been more than 10 seconds since we've sent a transition command,
    // reset the target state to the current state.

    if (Date.now() - this.lockInTransitionStart > 10000) {
      return new Promise((resolve, reject) => {
        this.getStatus().then(success => {
          const lockState = success ? this.deviceStatus.status?.lock?.lock?.value : undefined;
          if (lockState === undefined || lockState === null) {
            reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
            return;
          }
          // An unsettled state ('unknown', jammed) keeps the current target.
          this.targetState = this.mapTargetState(lockState) ?? this.targetState;
          this.log.debug(`Reset ${this.name} to ${this.targetState}`);
          resolve(this.targetState);
        }).catch(() => reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)));
      });
    } else {
      return this.targetState;
    }
  }

  // Set the target state of the lock
  async setLockTargetState(value: CharacteristicValue) {
    this.log.debug('Received setTargetState(' + value + ') event for ' + this.name);

    this.targetState = value as number;

    this.lockInTransitionStart = Date.now();
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, value);
    if (!(await this.multiServiceAccessory.sendCommand(this.componentId, 'lock', value ? 'lock' : 'unlock'))) {
      this.log.error(`Command failed for ${this.name}`);
      // Let the next poll resync the target from the device rather than hold the failed one.
      this.lockInTransitionStart = 0;
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name);
    this.multiServiceAccessory.forceNextStatusRefresh();
  }


  // Get the current state of the lock
  async getLockCurrentState(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getLockState() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        const lockState = success ? this.deviceStatus.status?.lock?.lock?.value : undefined;
        if (lockState !== undefined && lockState !== null) {
          this.log.debug(`LockState value from ${this.name}: ${lockState}`);
          resolve(this.mapLockState(lockState));
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      }).catch(() => reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)));
    });
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Event updating lock capability for ${this.name} to ${event.value}`);
    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.mapLockState(event.value));
    // Only a settled locked/unlocked report moves the target; 'unknown' or a jam must not flip it.
    const targetState = this.mapTargetState(event.value);
    if (targetState !== undefined) {
      this.targetState = targetState;
      this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.targetState);
    }
  }

  private mapTargetState(lockState: string): number | undefined {
    switch (lockState) {
      case 'locked':
        return this.platform.Characteristic.LockTargetState.SECURED;
      case 'unlocked':
      case 'unlocked with timeout':
        return this.platform.Characteristic.LockTargetState.UNSECURED;
      default:
        return undefined;
    }
  }

  public mapLockState(lockState:string): CharacteristicValue {
    switch (lockState) {
      case 'locked': {
        return(this.platform.Characteristic.LockCurrentState.SECURED);
      }
      case 'unlocked':
      case 'unlocked with timeout': {
        return(this.platform.Characteristic.LockCurrentState.UNSECURED);
      }
      case 'not fully locked': {
        return(this.platform.Characteristic.LockCurrentState.JAMMED);
      }
      default: {
        return(this.platform.Characteristic.LockCurrentState.UNKNOWN);
      }
    }

  }
}
