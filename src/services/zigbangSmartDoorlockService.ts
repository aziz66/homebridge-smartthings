import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class ZigbangSmartDoorlockService extends BaseService {
  private targetState = 0;
  private lockInTransitionStart = 0;
  private selectedLanguage = 'en';
  static readonly serviceNamespace = 'absoluteweather46907';
  // State events are emitted on the lockstaterelease capability; .lock is command-only (unlock).
  // The service must be registered/subscribed/routed under the STATE capability so real-time
  // lockstaterelease events reach processEvent(); unlock commands go to the COMMAND capability.
  public static readonly STATE_CAPABILITY_ID = `${ZigbangSmartDoorlockService.serviceNamespace}.lockstaterelease`;
  public static readonly COMMAND_CAPABILITY_ID = `${ZigbangSmartDoorlockService.serviceNamespace}.lock`;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.LockMechanism);
    // Set the event handlers
    this.log.debug(`Adding ZigbangSmartDoorlockService to ${this.name}`);
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
          if (!success) {
            reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
            return;
          }
          const ns = ZigbangSmartDoorlockService.serviceNamespace;
          const langStatus = this.deviceStatus.status[`${ns}.languageSupport`];
          const lockStatus = this.deviceStatus.status[`${ns}.lockstaterelease`];
          if (!langStatus || !lockStatus) {
            reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
            return;
          }
          this.selectedLanguage = langStatus.language.value;
          this.log.debug(`LanguageSupport value from ${this.name}: ${this.selectedLanguage}`);
          this.targetState = lockStatus.lock.value ===
            `locked.${this.selectedLanguage}` ?
            this.platform.Characteristic.LockTargetState.SECURED :
            this.platform.Characteristic.LockTargetState.UNSECURED;
          this.log.debug(`Reset ${this.name} to ${this.targetState}`);
          resolve(this.targetState);
        });
      });
    } else {
      return this.targetState;
    }
  }

  // Set the target state of the lock
  async setLockTargetState(value: CharacteristicValue) {
    this.log.debug('Received setTargetState(' + value + ') event for ' + this.name);

    this.targetState = value as number;

    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(this.name + ' is offline');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.lockInTransitionStart = Date.now();

    // ignore lock command as it supports unlock only
    // the door will automatically lock 7 seconds after the door lock is unlocked if the door is not opened
    if (value) {
      return;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, value);
    this.multiServiceAccessory.sendCommand(this.componentId, ZigbangSmartDoorlockService.COMMAND_CAPABILITY_ID, 'unlock')
    .then((success) => {
      if (success) {
        this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name);
        this.multiServiceAccessory.forceNextStatusRefresh();
        // this.deviceStatus.timestamp = 0; // Force refresh
      } else {
        this.log.error(`Command failed for ${this.name}`);
      }
    });
  }


  // Get the current state of the lock
  async getLockCurrentState(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getLockState() event for ' + this.name);

    try {
      // Real-time lockstaterelease events (routed via processEvent) are the primary source of
      // fresh state; getStatus() already triggers a background refresh, and polling is the backstop.
      const fetchedStatus = await this.getStatus();
      if (!fetchedStatus) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      const ns = ZigbangSmartDoorlockService.serviceNamespace;
      const langStatus = this.deviceStatus.status[`${ns}.languageSupport`];
      const lockStatus = this.deviceStatus.status[`${ns}.lockstaterelease`];
      if (!langStatus || !lockStatus) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      this.selectedLanguage = langStatus.language.value;
      this.log.debug(`LanguageSupport value from ${this.name}: ${this.selectedLanguage}`);
      const lockState = lockStatus.lock.value;
      this.log.debug(`LockState value from ${this.name}: ${lockState}`);
      return this.mapLockState(lockState);
    } catch (error) {
      this.log.error(`Failed to get current lock state for ${this.name}:`, error);
      if (error instanceof this.platform.api.hap.HapStatusError) {
        throw error;
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Event updating lock capability for ${this.name} to ${event.value}`);
    const mappedState = this.mapLockState(event.value);
    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, mappedState);
    if (mappedState === this.platform.Characteristic.LockCurrentState.SECURED) {
      this.targetState = this.platform.Characteristic.LockTargetState.SECURED;
    } else if (mappedState === this.platform.Characteristic.LockCurrentState.UNSECURED) {
      this.targetState = this.platform.Characteristic.LockTargetState.UNSECURED;
    } else {
      return;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.targetState);
  }

  public mapLockState(lockState:string): CharacteristicValue {
    // Values may be language-suffixed (e.g. 'locked.en', 'locked.ko'). Match on the
    // base token so mapping is language-agnostic and independent of whether the
    // device's languageSupport has been read yet — a real-time lockstaterelease
    // event can arrive before the first status read sets selectedLanguage.
    switch (lockState?.split('.')[0]) {
      case 'locked': {
        return(this.platform.Characteristic.LockCurrentState.SECURED);
      }
      case 'unlocked': {
        return(this.platform.Characteristic.LockCurrentState.UNSECURED);
      }
      default: {
        return(this.platform.Characteristic.LockCurrentState.UNKNOWN);
      }
    }

  }
}