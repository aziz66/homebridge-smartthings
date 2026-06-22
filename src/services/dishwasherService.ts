import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class DishwasherService extends BaseService {

  private cachedCompletionTime: string | null = null;
  // Tracks the last InUse value so we only seed the countdown on the OFF->ON (cycle-start) transition.
  private lastInUse: number | null = null;
  // Whether a non-zero RemainingDuration has been seeded for the current cycle (seed-once guard).
  private remainingSeeded = false;
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

    // IsConfigured: working valve/irrigation plugins set this; unconfigured valves don't render reliably
    this.service.setCharacteristic(platform.Characteristic.IsConfigured,
      platform.Characteristic.IsConfigured.CONFIGURED);

    // Active: machine is running or paused
    this.service.getCharacteristic(platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    // InUse: dishwasher job is actively working (wash/rinse/drying/etc)
    this.service.getCharacteristic(platform.Characteristic.InUse)
      .onGet(this.getInUse.bind(this));

    // SetDuration: read-only for an appliance, but Apple Home's countdown UI expects the
    // SetDuration/RemainingDuration pair. onSet is a no-op (we can't change the wash cycle).
    this.service.getCharacteristic(platform.Characteristic.SetDuration)
      .setProps({ maxValue: 14400 })
      .onGet(this.getRemainingDuration.bind(this))
      .onSet(this.setDuration.bind(this));

    // RemainingDuration: seeded ONCE at cycle start; Apple Home then decrements it client-side.
    this.service.getCharacteristic(platform.Characteristic.RemainingDuration)
      .setProps({ maxValue: 14400 })
      .onGet(this.getRemainingDuration.bind(this));

    // Seed initial values so a stale cached value isn't shown after a restart (matches reference plugins).
    this.service.updateCharacteristic(platform.Characteristic.RemainingDuration, 0);
    this.service.updateCharacteristic(platform.Characteristic.SetDuration, 0);

    // Poll using switch/light interval (appliances change state infrequently)
    let pollSeconds = 10;
    if (this.platform.config.PollSwitchesAndLightsSeconds !== undefined) {
      pollSeconds = this.platform.config.PollSwitchesAndLightsSeconds;
    }

    if (pollSeconds > 0) {
      // Single consolidated poll: pollValveState pushes InUse and (only on the cycle-start transition)
      // seeds SetDuration/RemainingDuration, then returns Active for startPollingState to push.
      // RemainingDuration is deliberately NOT re-pushed every poll - doing so resets Apple Home's
      // client-side countdown and leaves the tile stuck on "Waiting".
      multiServiceAccessory.startPollingState(pollSeconds, this.pollValveState.bind(this), this.service,
        platform.Characteristic.Active);
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

  // No-op setter for SetDuration (read-only appliance; we can't change the wash cycle length)
  async setDuration(value: CharacteristicValue) {
    this.log.debug(`DishwasherService setDuration(${value}) ignored for ${this.name} (read-only)`);
  }

  // Consolidated poll: reads status once, pushes InUse, seeds the countdown on the cycle-start
  // transition only, and returns Active (pushed by startPollingState).
  async pollValveState(): Promise<CharacteristicValue> {
    const success = await this.getStatus();
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const operatingState = this.deviceStatus.status.dishwasherOperatingState;
    if (!operatingState || !operatingState.machineState || !operatingState.dishwasherJobState) {
      this.log.error(`Missing dishwasherOperatingState from ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const machineState = operatingState.machineState.value;
    const jobState = operatingState.dishwasherJobState.value;
    this.log.debug(`Dishwasher machineState=${machineState} jobState=${jobState} for ${this.name}`);

    // Refresh the cached completion time from the current status (or the samsungce fallback).
    const completionTime = operatingState.completionTime?.value;
    if (completionTime) {
      this.cachedCompletionTime = completionTime;
    } else {
      this.tryRemainingTimeFallback();
    }

    const active = this.machineStateToActive(machineState);
    let inUse = this.jobStateToInUse(jobState);
    // A stopped/off machine can't be "in use", even if the device leaves jobState stale at end of cycle.
    if (active === this.platform.Characteristic.Active.INACTIVE) {
      inUse = this.platform.Characteristic.InUse.NOT_IN_USE;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.InUse, inUse);
    this.contactSensorService?.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      inUse === this.platform.Characteristic.InUse.IN_USE
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

    this.applyInUseTransition(inUse);

    return active;
  }

  // Seed the countdown ONCE per cycle, clear it on ON->OFF. While running, only (re)seeds if it
  // hasn't been seeded yet - e.g. when completionTime becomes available a poll after the cycle started.
  private applyInUseTransition(inUse: number): void {
    const IN_USE = this.platform.Characteristic.InUse.IN_USE;
    const wasInUse = this.lastInUse === IN_USE;
    const nowInUse = inUse === IN_USE;

    if (nowInUse && (!wasInUse || !this.remainingSeeded)) {
      this.seedRemainingDuration();
    } else if (!nowInUse && wasInUse) {
      this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, 0);
      this.remainingSeeded = false;
      this.log.debug(`Dishwasher cycle ended for ${this.name}: RemainingDuration 0`);
    }

    this.lastInUse = inUse;
  }

  // Pushes SetDuration/RemainingDuration once. If completionTime isn't available yet (seconds == 0)
  // it leaves remainingSeeded false so a later poll/event retries the seed.
  private seedRemainingDuration(): void {
    const secs = this.calculateRemainingSeconds();
    if (secs > 0) {
      this.service.updateCharacteristic(this.platform.Characteristic.SetDuration, secs);
      this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, secs);
      this.remainingSeeded = true;
      this.log.debug(`Dishwasher countdown seeded for ${this.name}: ${secs}s`);
    } else {
      this.log.debug(`Dishwasher in use but no completionTime yet for ${this.name}; will retry`);
    }
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

  // onGet for RemainingDuration / SetDuration. Serves Home app re-reads (e.g. when the app is
  // reopened) by computing the live remaining seconds from completionTime; it does not push.
  async getRemainingDuration(): Promise<CharacteristicValue> {
    return new Promise((resolve) => {
      this.getStatus().then(success => {
        if (!success) {
          resolve(this.calculateRemainingSeconds());
          return;
        }
        try {
          const completionTime = this.deviceStatus.status.dishwasherOperatingState.completionTime?.value;
          if (completionTime) {
            this.cachedCompletionTime = completionTime;
          } else {
            this.tryRemainingTimeFallback();
          }
        } catch (error) {
          this.log.debug(`No completionTime status available for ${this.name}`);
        }
        const remainingSeconds = this.calculateRemainingSeconds();
        this.log.debug(`Dishwasher RemainingDuration for ${this.name}: ${remainingSeconds}s`);
        resolve(remainingSeconds);
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
        // Convert relative minutes to an absolute completion timestamp for the countdown.
        this.cachedCompletionTime = new Date(Date.now() + remainingMin * 60 * 1000).toISOString();
        this.log.debug(`Dishwasher remainingTime fallback for ${this.name}: ${remainingMin} min`);
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

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'dishwasherOperatingState') {
      if (event.attribute === 'machineState') {
        this.log.debug(`Event updating dishwasher machineState for ${this.name} to ${event.value}`);
        const active = this.machineStateToActive(event.value);
        this.service.updateCharacteristic(this.platform.Characteristic.Active, active);

        // If machine stopped, clear the cached completion time and set remaining to 0.
        if (event.value === 'stop') {
          this.cachedCompletionTime = null;
          this.lastInUse = this.platform.Characteristic.InUse.NOT_IN_USE;
          this.remainingSeeded = false;
          this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, 0);
          this.contactSensorService?.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
          );
        }
      } else if (event.attribute === 'dishwasherJobState') {
        this.log.debug(`Event updating dishwasher jobState for ${this.name} to ${event.value}`);
        const inUse = this.jobStateToInUse(event.value);
        this.service.updateCharacteristic(this.platform.Characteristic.InUse, inUse);
        this.contactSensorService?.updateCharacteristic(
          this.platform.Characteristic.ContactSensorState,
          this.jobStateToContactSensor(event.value),
        );
        // Seed the countdown once on the cycle-start transition.
        this.applyInUseTransition(inUse);
      } else if (event.attribute === 'completionTime') {
        // completionTime is an attribute of dishwasherOperatingState
        this.log.debug(`Event updating dishwasher completionTime for ${this.name} to ${event.value}`);
        this.cachedCompletionTime = event.value;
        // Refresh RemainingDuration when a cycle is running (real change / late-arriving completionTime).
        if (this.lastInUse === this.platform.Characteristic.InUse.IN_USE) {
          const secs = this.calculateRemainingSeconds();
          this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, secs);
          this.remainingSeeded = secs > 0;
        }
      }
    }
  }
}
