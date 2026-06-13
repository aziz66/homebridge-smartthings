import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class WindowCoveringService extends BaseService {
  // null = not yet learned. HomeKit shows 'Opening…'/'Closing…' whenever
  // TargetPosition differs from CurrentPosition, so a hardcoded startup target
  // would make any shade not sitting at that exact position spin forever.
  private targetPosition: number | null = null;
  private currentPosition: number | null = null;
  private timer;
  private states = {
    decreasing: this.platform.Characteristic.PositionState.DECREASING,
    increasing: this.platform.Characteristic.PositionState.INCREASING,
    stopped: this.platform.Characteristic.PositionState.STOPPED,
  };

  private currentPositionState = this.states.stopped;

  private useWindowShadeLevel = false;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.WindowCovering);
    // Set the event handlers
    this.log.debug(`Adding WindowCoveringService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.CurrentPosition)
      .onGet(this.getCurrentPosition.bind(this));
    this.service.getCharacteristic(platform.Characteristic.PositionState)
      .onGet(this.getCurrentPositionState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.TargetPosition)
      .onGet(this.getTargetPosition.bind(this))
      .onSet(this.setTargetPosition.bind(this));

    let pollWindowShadesSeconds = 10; // default to 10 seconds
    if (this.platform.config.PollWindowShadesSeconds !== undefined) {
      pollWindowShadesSeconds = this.platform.config.PollWindowShadesSeconds;
    }

    if (pollWindowShadesSeconds > 0) {
      multiServiceAccessory.startPollingState(pollWindowShadesSeconds, this.getCurrentPosition.bind(this), this.service,
        platform.Characteristic.CurrentPosition, platform.Characteristic.TargetPosition, this.getTargetPosition.bind(this));
      multiServiceAccessory.startPollingState(pollWindowShadesSeconds, this.getCurrentPositionState.bind(this), this.service,
        platform.Characteristic.PositionState);
    }

    if (this.capabilities.includes('windowShadeLevel')) {
      this.useWindowShadeLevel = true;
    }

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setTargetPosition(value: CharacteristicValue) {

    this.log.debug('Received setTargetPosition(' + value + ') event for ' + this.name);

    this.targetPosition = value as number;

    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(this.name + ' is offline');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    let capability = 'switchLevel';
    let command = 'setLevel';
    let args: unknown[] = [value];

    if (this.capabilities.includes('windowShade') && (this.targetPosition === 0 || this.targetPosition === 100)) {
      // At the travel limits, use the windowShade capability's mandatory
      // open/close commands instead of a level command — some Z-Wave shade
      // drivers intermittently ignore setShadeLevel(0)/setLevel(0) while
      // honoring close immediately. Only valid if the device actually exposes
      // windowShade; a windowShadeLevel/switchLevel-only device falls through
      // to the level command below.
      capability = 'windowShade';
      command = this.targetPosition === 0 ? 'close' : 'open';
      args = [];
    } else if (this.useWindowShadeLevel) {
      capability = 'windowShadeLevel';
      command = 'setShadeLevel';
    }

    this.multiServiceAccessory.sendCommand(this.componentId, capability, command, args)
      .then(() => {
        this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name);
        this.multiServiceAccessory.forceNextStatusRefresh();
      })
      .catch(reason => {
        this.log.error('onSet(' + value + ') FAILED for ' + this.name + ': reason ' + reason);
        throw (new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      });
  }

  async getTargetPosition(): Promise<CharacteristicValue> {
    return new Promise(resolve => {
      if (this.targetPosition !== null) {
        resolve(this.targetPosition);
      } else {
        // No target learned yet (no HomeKit command, no status sync) — report
        // the last known position so HomeKit doesn't invent a phantom move.
        resolve(this.currentPosition ?? 0);
      }
    });
  }

  async getCurrentPositionState(): Promise<CharacteristicValue> {
    this.log.debug('Received getCurrentPositionState() event for ' + this.name);
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          // Guard the read: the service can also be matched on a
          // windowShadeLevel/switchLevel-only device that never exposes
          // windowShade, in which case there is no movement state to report.
          const state = this.deviceStatus.status.windowShade?.windowShade?.value;
          // HomeKit position semantics: 100 = fully open, 0 = fully closed,
          // so 'opening' means the position is INCREASING.
          if (state === 'opening') {
            this.currentPositionState = this.states.increasing;
          } else if (state === 'closing') {
            this.currentPositionState = this.states.decreasing;
          } else {
            this.currentPositionState = this.states.stopped;
            this.syncTargetPosition(this.readPositionFromStatus());
          }
          this.log.debug(`getCurrentPositionState() SUCCESSFUL for ${this.name} return value ${state}, ` +
            `setting to ${this.currentPositionState}`);
          resolve(this.currentPositionState);
        } else {
          this.log.error('getCurrentPositionState() FAILED for ' + this.name);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }


  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getCurrentPosition(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    return new Promise<CharacteristicValue>((resolve, reject) => {

      if (!this.multiServiceAccessory.isOnline()) {
        this.log.error(this.name + ' is offline');
        return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }

      this.getStatus().then(success => {

        if (success) {
          const position = this.readPositionFromStatus();
          if (position === null) {
            this.log.error('onGet() FAILED for ' + this.name + '. Undefined value');
            return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          }
          this.currentPosition = position;
          if (this.currentPositionState === this.states.stopped) {
            this.syncTargetPosition(position);
          }
          this.log.debug('onGet() SUCCESSFUL for ' + this.name + '. value = ' + position);
          resolve(position);
        } else {
          this.log.error('onGet() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'windowShadeLevel' || event.capability === 'switchLevel') {
      this.log.debug(`Event updating windowShadeLevel capability for ${this.name} to ${event.value}`);
      this.currentPosition = event.value;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, event.value);
      if (this.currentPositionState === this.states.stopped) {
        this.syncTargetPosition(event.value);
      }
    } else if (event.capability === 'windowShade') {
      this.log.debug(`Event updating windowShade capability for ${this.name} to ${event.value}`);
      if (event.value === 'opening') {
        this.currentPositionState = this.states.increasing;
      } else if (event.value === 'closing') {
        this.currentPositionState = this.states.decreasing;
      } else {
        this.currentPositionState = this.states.stopped;
        this.syncTargetPosition(this.currentPosition);
      }
      this.log.debug(`From event, setting characteristic to ${this.currentPositionState}`);
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.currentPositionState);
    }
  }

  // Reads the shade position from the cached device status, from whichever
  // level capability this device exposes. Returns null if not yet available.
  private readPositionFromStatus(): number | null {
    const status = this.deviceStatus.status;
    const position = this.useWindowShadeLevel
      ? status.windowShadeLevel?.shadeLevel?.value
      : status.switchLevel?.level?.value;
    return typeof position === 'number' ? position : null;
  }

  // When the shade is idle, TargetPosition must mirror the real position or
  // HomeKit reports a phantom 'Opening…'/'Closing…' until they match. Shades
  // moved outside HomeKit (remote, SmartThings app, automations) only get
  // their target reconciled here.
  private syncTargetPosition(position: number | null) {
    if (position === null || this.targetPosition === position) {
      return;
    }
    this.targetPosition = position;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, position);
  }


  // getPositionState(): number {
  //   this.log.debug('GetPositionState called, value: ' + this.shadeState);
  //   return this.shadeState;
  // }


}
