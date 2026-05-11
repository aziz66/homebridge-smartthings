import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class DishwasherService extends BaseService {

  private cachedCompletionTime: string | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private contactSensorService: Service | undefined;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Valve);
    this.log.debug(`Adding DishwasherService to ${this.name}`);

    // ValveType: GENERIC_VALVE so Apple Home shows it as a generic valve with countdown
    this.service.getCharacteristic(platform.Characteristic.ValveType)
      .updateValue(platform.Characteristic.ValveType.GENERIC_VALVE);

    // Active: machine is running or paused
    this.service.getCharacteristic(platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    // InUse: dishwasher job is actively working (wash/rinse/drying/etc)
    this.service.getCharacteristic(platform.Characteristic.InUse)
      .onGet(this.getInUse.bind(this));

    // RemainingDuration: Apple Home auto-decrements the countdown display for Valve services
    this.service.getCharacteristic(platform.Characteristic.RemainingDuration)
      .setProps({ maxValue: 14400 })
      .onGet(this.getRemainingDuration.bind(this));

    // Poll using switch/light interval (appliances change state infrequently)
    let pollSeconds = 10;
    if (this.platform.config.PollSwitchesAndLightsSeconds !== undefined) {
      pollSeconds = this.platform.config.PollSwitchesAndLightsSeconds;
    }

    if (pollSeconds > 0) {
      multiServiceAccessory.startPollingState(pollSeconds, this.getActive.bind(this), this.service,
        platform.Characteristic.Active);
      multiServiceAccessory.startPollingState(pollSeconds, this.getInUse.bind(this), this.service,
        platform.Characteristic.InUse);
    }

    // Optional Contact Sensor for Activity Notifications
    if (this.platform.config.ExposeContactSensorForDishwashers) {
      const contactSubtype = 'dishwasher-contact-sensor';
      this.contactSensorService = this.accessory.getService(contactSubtype) ||
        this.accessory.addService(platform.Service.ContactSensor, `${this.name} Activity`, contactSubtype);

      this.contactSensorService.getCharacteristic(platform.Characteristic.ContactSensorState)
        .onGet(this.getContactSensorState.bind(this));

      if (pollSeconds > 0) {
        multiServiceAccessory.startPollingState(pollSeconds, this.getContactSensorState.bind(this),
          this.contactSensorService, platform.Characteristic.ContactSensorState);
      }
    }
  }

  // No-op setter for Active (Valve requires it; dishwasher is read-only)
  async setActive(value: CharacteristicValue) {
    this.log.debug(`DishwasherService setActive(${value}) ignored for ${this.name} (read-only)`);
  }

  async getActive(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        try {
          const machineState = this.deviceStatus.status.dishwasherOperatingState.machineState.value;
          this.log.debug(`Dishwasher machineState for ${this.name}: ${machineState}`);
          resolve(this.machineStateToActive(machineState));
        } catch (error) {
          this.log.error(`Missing dishwasherOperatingState.machineState from ${this.name}`);
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
          const jobState = this.deviceStatus.status.dishwasherOperatingState.dishwasherJobState.value;
          this.log.debug(`Dishwasher jobState for ${this.name}: ${jobState}`);
          resolve(this.jobStateToInUse(jobState));
        } catch (error) {
          this.log.error(`Missing dishwasherOperatingState.dishwasherJobState from ${this.name}`);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async getContactSensorState(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        try {
          const jobState = this.deviceStatus.status.dishwasherOperatingState.dishwasherJobState.value;
          resolve(this.jobStateToContactSensor(jobState));
        } catch (error) {
          this.log.error(`Missing dishwasherOperatingState.dishwasherJobState from ${this.name}`);
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
          // completionTime is an attribute of dishwasherOperatingState, not a separate capability
          const completionTime = this.deviceStatus.status.dishwasherOperatingState.completionTime?.value;
          if (completionTime) {
            this.cachedCompletionTime = completionTime;
            this.startCountdownTimer();
          } else {
            // Fallback: use samsungce.dishwasherOperatingState.remainingTime (integer minutes)
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
    case 'airwash':
    case 'cooling':
    case 'drying':
    case 'preDrain':
    case 'prewash':
    case 'rinse':
    case 'spin':
    case 'wash':
    case 'wrinklePrevent':
      return this.platform.Characteristic.InUse.IN_USE;
    default:
      return this.platform.Characteristic.InUse.NOT_IN_USE;
    }
  }

  private jobStateToContactSensor(jobState: string): number {
    const inUse = this.jobStateToInUse(jobState);
    return inUse === this.platform.Characteristic.InUse.IN_USE
      ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  private tryRemainingTimeFallback(): void {
    try {
      const remainingMin = this.deviceStatus.status['samsungce.dishwasherOperatingState']?.remainingTime?.value;
      if (typeof remainingMin === 'number' && remainingMin > 0) {
        // Convert relative minutes to an absolute completion timestamp for the countdown timer
        this.cachedCompletionTime = new Date(Date.now() + remainingMin * 60 * 1000).toISOString();
        this.log.debug(`Dishwasher remainingTime fallback for ${this.name}: ${remainingMin} min`);
        this.startCountdownTimer();
      }
    } catch {
      // samsungce.dishwasherOperatingState not available — ignore
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
    if (event.capability === 'dishwasherOperatingState') {
      if (event.attribute === 'machineState') {
        this.log.debug(`Event updating dishwasher machineState for ${this.name} to ${event.value}`);
        const active = this.machineStateToActive(event.value);
        this.service.updateCharacteristic(this.platform.Characteristic.Active, active);

        // If machine stopped, clear timer and set remaining to 0
        if (event.value === 'stop') {
          this.cachedCompletionTime = null;
          this.stopCountdownTimer();
          this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, 0);
          this.contactSensorService?.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
          );
        }
      } else if (event.attribute === 'dishwasherJobState') {
        this.log.debug(`Event updating dishwasher jobState for ${this.name} to ${event.value}`);
        this.service.updateCharacteristic(this.platform.Characteristic.InUse, this.jobStateToInUse(event.value));
        this.contactSensorService?.updateCharacteristic(
          this.platform.Characteristic.ContactSensorState,
          this.jobStateToContactSensor(event.value),
        );
      } else if (event.attribute === 'completionTime') {
        // completionTime is an attribute of dishwasherOperatingState
        this.log.debug(`Event updating dishwasher completionTime for ${this.name} to ${event.value}`);
        this.cachedCompletionTime = event.value;
        const remaining = this.calculateRemainingSeconds();
        this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, remaining);
        this.startCountdownTimer();
      }
    }
  }
}
