import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class StatelessProgrammableSwitchService extends BaseService {
  private lastPressTimestamp: string | undefined;
  private webhookDelivering = false;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities:string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.StatelessProgrammableSwitch);
    this.log.debug(`Adding StatelessProgrammableSwitchService to ${this.name}`);

    // ProgrammableSwitchEvent is event-only: HAP answers every read with null (hap-nodejs ignores
    // any onGet handler for it) and treats every updateCharacteristic() as a fresh button press.
    // So it is not polled through startPollingState() - replaying the last reported value each poll
    // produced phantom presses. Webhook events (processEvent) deliver presses; pollForPress() is the
    // fallback for setups without webhooks.
    let pollSwitchesAndLightsSeconds = 10; // default to 10 seconds
    if (this.platform.config.PollSwitchesAndLightsSeconds !== undefined) {
      pollSwitchesAndLightsSeconds = this.platform.config.PollSwitchesAndLightsSeconds;
    }
    if (pollSwitchesAndLightsSeconds > 0) {
      setInterval(() => {
        this.pollForPress();
      }, pollSwitchesAndLightsSeconds * 1000 + Math.floor(Math.random() * 1000)).unref();
    }
  }

  // A new press is recognised by a change of the button attribute's timestamp - its value repeats
  // ("pushed" twice in a row is two presses). The first poll only records a baseline, and once a
  // webhook event has arrived events are the source of truth, so a press is never delivered twice.
  private async pollForPress(): Promise<void> {
    if (this.webhookDelivering) {
      return;
    }
    try {
      if (!(await this.getStatus())) {
        return;
      }
      const attribute = this.deviceStatus.status?.button?.button;
      const timestamp = attribute?.timestamp;
      if (typeof timestamp !== 'string' || timestamp === this.lastPressTimestamp) {
        return;
      }
      const isBaseline = this.lastPressTimestamp === undefined;
      this.lastPressTimestamp = timestamp;
      if (isBaseline) {
        return;
      }
      const characteristicValue = this.mapValue(attribute?.value);
      if (characteristicValue !== undefined) {
        this.log.debug(`Poll detected a button press on ${this.name}: ${attribute?.value}`);
        this.service.updateCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent, characteristicValue);
      }
    } catch (error) {
      this.log.debug(`Button poll failed for ${this.name}: ${(error as Error)?.message || error}`);
    }
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'button') {
      if (event.attribute !== undefined && event.attribute !== 'button') {
        return;   // e.g. numberOfButtons / supportedButtonValues
      }
      this.webhookDelivering = true;
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
