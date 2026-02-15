import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class WasherService extends BaseService {

  private cachedCompletionTime: string | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Valve);
    this.log.debug(`Adding WasherService to ${this.name}`);

    // ValveType: GENERIC_VALVE so Apple Home shows it as a generic valve with countdown
    this.service.getCharacteristic(platform.Characteristic.ValveType)
      .updateValue(platform.Characteristic.ValveType.GENERIC_VALVE);

    // Active: machine is running or paused
    this.service.getCharacteristic(platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    // InUse: washer job is actively working (wash/rinse/spin)
    this.service.getCharacteristic(platform.Characteristic.InUse)
      .onGet(this.getInUse.bind(this));

    // RemainingDuration: Apple Home auto-decrements the countdown display for Valve services
    this.service.getCharacteristic(platform.Characteristic.RemainingDuration)
      .setProps({ maxValue: 14400 })
      .onGet(this.getRemainingDuration.bind(this));

    // Poll using sensor interval
    let pollSensorsSeconds = 10;
    if (this.platform.config.PollSensorsSeconds !== undefined) {
      pollSensorsSeconds = this.platform.config.PollSensorsSeconds;
    }

    if (pollSensorsSeconds > 0) {
      multiServiceAccessory.startPollingState(pollSensorsSeconds, this.getActive.bind(this), this.service,
        platform.Characteristic.Active);
      multiServiceAccessory.startPollingState(pollSensorsSeconds, this.getInUse.bind(this), this.service,
        platform.Characteristic.InUse);
    }
  }

  // No-op setter for Active (Valve requires it; washer is read-only)
  async setActive(value: CharacteristicValue) {
    this.log.debug(`WasherService setActive(${value}) ignored for ${this.name} (read-only)`);
  }

  async getActive(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        try {
          const machineState = this.deviceStatus.status.washerOperatingState.machineState.value;
          this.log.debug(`Washer machineState for ${this.name}: ${machineState}`);
          resolve(this.machineStateToActive(machineState));
        } catch (error) {
          this.log.error(`Missing washerOperatingState.machineState from ${this.name}`);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async getInUse(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        try {
          const jobState = this.deviceStatus.status.washerOperatingState.washerJobState.value;
          this.log.debug(`Washer jobState for ${this.name}: ${jobState}`);
          resolve(this.jobStateToInUse(jobState));
        } catch (error) {
          this.log.error(`Missing washerOperatingState.washerJobState from ${this.name}`);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async getRemainingDuration(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        try {
          // completionTime is an attribute of washerOperatingState, not a separate capability
          const completionTime = this.deviceStatus.status.washerOperatingState.completionTime?.value;
          if (completionTime) {
            this.cachedCompletionTime = completionTime;
            this.startCountdownTimer();
          } else {
            // Fallback: use samsungce.washerOperatingState.remainingTime (integer minutes)
            this.tryRemainingTimeFallback();
          }
          resolve(this.calculateRemainingSeconds());
        } catch (error) {
          this.log.debug(`No completionTime status available for ${this.name}`);
          resolve(0);
        }
      });
    });
  }

  private machineStateToActive(machineState: string): number {
    switch (machineState) {
    case 'run':
    case 'pause':
      return this.platform.Characteristic.Active.ACTIVE;
    default:
      return this.platform.Characteristic.Active.INACTIVE;
    }
  }

  private jobStateToInUse(jobState: string): number {
    switch (jobState) {
    case 'wash':
    case 'rinse':
    case 'spin':
    case 'weightSensing':
    case 'wrinklePrevent':
    case 'drying':
      return this.platform.Characteristic.InUse.IN_USE;
    default:
      return this.platform.Characteristic.InUse.NOT_IN_USE;
    }
  }

  private tryRemainingTimeFallback(): void {
    try {
      const remainingMin = this.deviceStatus.status['samsungce.washerOperatingState']?.remainingTime?.value;
      if (typeof remainingMin === 'number' && remainingMin > 0) {
        // Convert relative minutes to an absolute completion timestamp for the countdown timer
        this.cachedCompletionTime = new Date(Date.now() + remainingMin * 60 * 1000).toISOString();
        this.log.debug(`Washer remainingTime fallback for ${this.name}: ${remainingMin} min`);
        this.startCountdownTimer();
      }
    } catch {
      // samsungce.washerOperatingState not available — ignore
    }
  }

  private calculateRemainingSeconds(): number {
    if (!this.cachedCompletionTime) {
      return 0;
    }
    const parsed = Date.parse(this.cachedCompletionTime);
    if (isNaN(parsed)) {
      this.log.warn(`Invalid completionTime value for ${this.name}: ${this.cachedCompletionTime}`);
      return 0;
    }
    const remaining = Math.max(0, Math.floor((parsed - Date.now()) / 1000));
    return Math.min(remaining, 14400);
  }

  private startCountdownTimer(): void {
    this.stopCountdownTimer();
    const remaining = this.calculateRemainingSeconds();
    if (remaining <= 0) {
      return;
    }
    this.countdownTimer = setInterval(() => {
      const secs = this.calculateRemainingSeconds();
      this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, secs);
      if (secs <= 0) {
        this.stopCountdownTimer();
      }
    }, 60 * 1000);
  }

  private stopCountdownTimer(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'washerOperatingState') {
      if (event.attribute === 'machineState') {
        this.log.debug(`Event updating washer machineState for ${this.name} to ${event.value}`);
        const active = this.machineStateToActive(event.value);
        this.service.updateCharacteristic(this.platform.Characteristic.Active, active);

        // If machine stopped, clear timer and set remaining to 0
        if (event.value === 'stop') {
          this.cachedCompletionTime = null;
          this.stopCountdownTimer();
          this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, 0);
        }
      } else if (event.attribute === 'washerJobState') {
        this.log.debug(`Event updating washer jobState for ${this.name} to ${event.value}`);
        this.service.updateCharacteristic(this.platform.Characteristic.InUse, this.jobStateToInUse(event.value));
      } else if (event.attribute === 'completionTime') {
        // completionTime is an attribute of washerOperatingState
        this.log.debug(`Event updating washer completionTime for ${this.name} to ${event.value}`);
        this.cachedCompletionTime = event.value;
        const remaining = this.calculateRemainingSeconds();
        this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, remaining);
        this.startCountdownTimer();
      }
    }
  }
}
