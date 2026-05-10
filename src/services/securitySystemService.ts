import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { Command } from './smartThingsCommand';

export class SecuritySystemService extends BaseService {
  private targetState: number;
  private supportsArmNight = false;

  // Last fully-settled CurrentState (STAY/AWAY/NIGHT/DISARMED). Used to mask
  // intermediate panel states like 'arming'/'disarming' so the HomeKit tile
  // doesn't flicker back to "Off" while the panel is in transition.
  private lastSettledCurrentState: number;

  // Track each alarm source independently so AlarmType only clears
  // when ALL active sources have cleared.
  private alarmActive = {
    siren: false,
    panic: false,
    tempAlarm: false,
  };

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.SecuritySystem);
    this.log.debug(`Adding SecuritySystemService to ${this.name}`);

    this.targetState = platform.Characteristic.SecuritySystemTargetState.DISARM;
    this.lastSettledCurrentState = platform.Characteristic.SecuritySystemCurrentState.DISARMED;

    // Constrain valid target states based on supportedSecuritySystemCommands.
    // Devices that don't expose the array fall back to a conservative subset
    // (no NIGHT_ARM) — better UX than silently mapping NIGHT_ARM to STAY.
    const validTargets = this.deriveValidTargetValues();
    this.supportsArmNight = validTargets.includes(platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM);
    this.log.debug(`${this.name} supported target states: ${validTargets.join(',')}`);

    this.service.getCharacteristic(platform.Characteristic.SecuritySystemTargetState)
      .setProps({ validValues: validTargets });

    this.service.getCharacteristic(platform.Characteristic.SecuritySystemCurrentState)
      .onGet(this.getCurrentState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.SecuritySystemTargetState)
      .onGet(this.getTargetState.bind(this))
      .onSet(this.setTargetState.bind(this));

    const hasAlarmCapability =
      capabilities.includes('alarm') ||
      capabilities.includes('panicAlarm') ||
      capabilities.includes('temperatureAlarm');
    if (hasAlarmCapability) {
      this.service.getCharacteristic(platform.Characteristic.SecuritySystemAlarmType)
        .onGet(this.getAlarmType.bind(this));
    }

    // Seed targetState from current state so HomeKit shows the right mode
    // immediately after pairing rather than defaulting to DISARM.
    this.getCurrentState().then(currentState => {
      this.targetState = this.mapCurrentToTarget(currentState as number);
    }).catch(() => {
      this.log.debug(`Failed to seed initial target state for ${this.name}`);
    });

    let pollSec = 15;
    if (this.platform.config.PollSecuritySystemsSeconds !== undefined) {
      pollSec = this.platform.config.PollSecuritySystemsSeconds;
    }

    if (pollSec > 0) {
      multiServiceAccessory.startPollingState(pollSec, this.getCurrentState.bind(this), this.service,
        platform.Characteristic.SecuritySystemCurrentState,
        platform.Characteristic.SecuritySystemTargetState, this.getTargetState.bind(this));
    }
  }

  // Build the validValues array for SecuritySystemTargetState. Reads
  // securitySystem.supportedSecuritySystemCommands from cached device status if
  // present; otherwise defaults to [STAY_ARM, AWAY_ARM, DISARM] (no night).
  private deriveValidTargetValues(): number[] {
    const C = this.platform.Characteristic.SecuritySystemTargetState;
    const supported = this.deviceStatus?.status?.securitySystem?.supportedSecuritySystemCommands?.value;

    if (Array.isArray(supported) && supported.length > 0) {
      const values: number[] = [];
      if (supported.includes('armStay')) {
        values.push(C.STAY_ARM);
      }
      if (supported.includes('armAway')) {
        values.push(C.AWAY_ARM);
      }
      if (supported.includes('armNight')) {
        values.push(C.NIGHT_ARM);
      }
      if (supported.includes('disarm')) {
        values.push(C.DISARM);
      }
      // Always allow DISARM even if a misbehaving driver omits it
      if (!values.includes(C.DISARM)) {
        values.push(C.DISARM);
      }
      return values;
    }

    return [C.STAY_ARM, C.AWAY_ARM, C.DISARM];
  }

  async getTargetState(): Promise<CharacteristicValue> {
    return this.targetState;
  }

  async setTargetState(value: CharacteristicValue) {
    this.log.debug(`Received setTargetState(${value}) event for ${this.name}`);
    this.targetState = value as number;

    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(`${this.name} is offline`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const C = this.platform.Characteristic.SecuritySystemTargetState;
    let cmd: Command;

    switch (value) {
      case C.STAY_ARM:
        cmd = new Command(this.componentId, 'securitySystem', 'armStay', [false]);
        break;
      case C.AWAY_ARM:
        cmd = new Command(this.componentId, 'securitySystem', 'armAway', [false]);
        break;
      case C.NIGHT_ARM:
        if (this.supportsArmNight) {
          cmd = new Command(this.componentId, 'securitySystem', 'armNight', [false]);
        } else {
          this.log.warn(`${this.name} does not support armNight; falling back to armStay`);
          cmd = new Command(this.componentId, 'securitySystem', 'armStay', [false]);
        }
        break;
      case C.DISARM:
      default:
        cmd = new Command(this.componentId, 'securitySystem', 'disarm');
        break;
    }

    // Optimistically push CurrentState so HomeKit doesn't sit on the
    // intermediate 'arming'/'disarming' value reported by the panel.
    // Webhook/poll will correct if SmartThings rejects the command.
    this.service.updateCharacteristic(
      this.platform.Characteristic.SecuritySystemCurrentState,
      this.mapTargetToCurrent(this.targetState),
    );

    this.multiServiceAccessory.sendCommands([cmd]).then(success => {
      if (success) {
        this.log.debug(`setTargetState(${value}) SUCCESSFUL for ${this.name}`);
        this.multiServiceAccessory.forceNextStatusRefresh();
      } else {
        this.log.error(`Command failed for ${this.name}`);
      }
    });
  }

  async getCurrentState(): Promise<CharacteristicValue> {
    this.log.debug(`Received getCurrentState() event for ${this.name}`);
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }

        const armState = this.deviceStatus?.status?.securitySystem?.securitySystemStatus?.value;
        this.log.debug(`securitySystemStatus value from ${this.name}: ${armState}`);

        // Refresh per-source alarm flags from cached status so the override
        // logic below doesn't depend on having seen a webhook event yet.
        this.refreshAlarmFlagsFromStatus();

        if (this.anyAlarmActive()) {
          resolve(this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);
          return;
        }

        resolve(this.resolveCurrentState(armState));
      }).catch(error => {
        this.log.debug(`getCurrentState failed for ${this.name}: ${error}`);
        reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      });
    });
  }

  async getAlarmType(): Promise<CharacteristicValue> {
    this.refreshAlarmFlagsFromStatus();
    return this.anyAlarmActive() ? 1 : 0;
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Updating ${event.capability}/${event.attribute} for ${this.name} from event to ${event.value}`);

    switch (event.capability) {
      case 'securitySystem':
        if (event.attribute === 'securitySystemStatus') {
          const settled = this.mapArmState(event.value);
          if (settled === null) {
            // Intermediate state ('arming'/'disarming') — keep showing the
            // optimistic value pushed by setTargetState until the panel settles.
            this.log.debug(`Ignoring intermediate securitySystemStatus '${event.value}' for ${this.name}`);
            break;
          }
          this.lastSettledCurrentState = settled;
          const current = this.anyAlarmActive()
            ? this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
            : settled;
          this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState, current);

          this.targetState = this.mapCurrentToTarget(settled);
          this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, this.targetState);
        }
        break;

      case 'alarm':
        if (event.attribute === 'alarm') {
          this.alarmActive.siren = event.value === 'siren' || event.value === 'both';
          this.pushAlarmStateUpdate();
        }
        break;

      case 'panicAlarm':
        if (event.attribute === 'panicAlarm') {
          this.alarmActive.panic = event.value === 'panic';
          this.pushAlarmStateUpdate();
        }
        break;

      case 'temperatureAlarm':
        if (event.attribute === 'temperatureAlarm') {
          this.alarmActive.tempAlarm = event.value === 'heat' || event.value === 'freeze';
          this.pushAlarmStateUpdate();
        }
        break;
    }
  }

  // Push a CurrentState/AlarmType update reflecting the current alarmActive flags
  // plus the most recent armed/disarmed status from cached device status.
  private pushAlarmStateUpdate(): void {
    if (this.anyAlarmActive()) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.SecuritySystemCurrentState,
        this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED,
      );
      this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemAlarmType, 1);
    } else {
      const armState = this.deviceStatus?.status?.securitySystem?.securitySystemStatus?.value;
      this.service.updateCharacteristic(
        this.platform.Characteristic.SecuritySystemCurrentState,
        this.resolveCurrentState(armState),
      );
      this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemAlarmType, 0);
    }
  }

  private refreshAlarmFlagsFromStatus(): void {
    const status = this.deviceStatus?.status;
    if (!status) {
      return;
    }
    if (this.capabilities.includes('alarm')) {
      const v = status.alarm?.alarm?.value;
      this.alarmActive.siren = v === 'siren' || v === 'both';
    }
    if (this.capabilities.includes('panicAlarm')) {
      this.alarmActive.panic = status.panicAlarm?.panicAlarm?.value === 'panic';
    }
    if (this.capabilities.includes('temperatureAlarm')) {
      const v = status.temperatureAlarm?.temperatureAlarm?.value;
      this.alarmActive.tempAlarm = v === 'heat' || v === 'freeze';
    }
  }

  private anyAlarmActive(): boolean {
    return this.alarmActive.siren || this.alarmActive.panic || this.alarmActive.tempAlarm;
  }

  // Returns null for intermediate ('arming'/'disarming') or unknown values
  // so callers can preserve the last settled state instead of flickering.
  private mapArmState(armState: string | undefined): number | null {
    const C = this.platform.Characteristic.SecuritySystemCurrentState;
    switch (armState) {
      case 'armedStay':
        return C.STAY_ARM;
      case 'armedAway':
        return C.AWAY_ARM;
      case 'armedNight':
        return C.NIGHT_ARM;
      case 'disarmed':
        return C.DISARMED;
      default:
        return null;
    }
  }

  // Resolve the SmartThings arm state to a concrete CurrentState value,
  // updating lastSettledCurrentState when a settled value is observed.
  private resolveCurrentState(armState: string | undefined): number {
    const mapped = this.mapArmState(armState);
    if (mapped !== null) {
      this.lastSettledCurrentState = mapped;
      return mapped;
    }
    return this.lastSettledCurrentState;
  }

  private mapCurrentToTarget(currentState: number): number {
    const Curr = this.platform.Characteristic.SecuritySystemCurrentState;
    const Tgt = this.platform.Characteristic.SecuritySystemTargetState;
    switch (currentState) {
      case Curr.STAY_ARM:
        return Tgt.STAY_ARM;
      case Curr.AWAY_ARM:
        return Tgt.AWAY_ARM;
      case Curr.NIGHT_ARM:
        return Tgt.NIGHT_ARM;
      case Curr.ALARM_TRIGGERED:
      case Curr.DISARMED:
      default:
        return Tgt.DISARM;
    }
  }

  private mapTargetToCurrent(targetState: number): number {
    const Curr = this.platform.Characteristic.SecuritySystemCurrentState;
    const Tgt = this.platform.Characteristic.SecuritySystemTargetState;
    switch (targetState) {
      case Tgt.STAY_ARM:
        return Curr.STAY_ARM;
      case Tgt.AWAY_ARM:
        return Curr.AWAY_ARM;
      case Tgt.NIGHT_ARM:
        return Curr.NIGHT_ARM;
      case Tgt.DISARM:
      default:
        return Curr.DISARMED;
    }
  }
}
