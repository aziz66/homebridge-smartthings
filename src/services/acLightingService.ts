import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Command } from './smartThingsCommand';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { BaseService } from './baseService';

// Constants for Samsung AC lighting capability
const CAP = 'samsungce.airConditionerLighting';
const ATTR = 'lighting';

export class ACLightingService extends BaseService {
  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
    componentId: string,
    capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string,
    deviceStatus,
  ) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding ACLightingService to ${this.name} for component ${componentId}`);
    this.log.debug(`ACLightingService capabilities: ${JSON.stringify(capabilities)}`);
    const lightingCapability = deviceStatus?.[CAP];
    this.log.debug(`Device status contains ${CAP}: ${JSON.stringify(lightingCapability, null, 2)}`);

    // Add a Lightbulb service for the Samsung AC lighting
    this.setServiceType(platform.Service.Lightbulb);

    // Set the display name for this service
    this.service.setCharacteristic(platform.Characteristic.Name, `${this.name} Display Light`);

    // Configure the On/Off characteristic
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getLightState.bind(this))
      .onSet(this.setLightState.bind(this));

    // Start polling to keep the state updated
    multiServiceAccessory.startPollingState(
      this.platform.config.PollSwitchesAndLightsSeconds,
      this.getLightState.bind(this),
      this.service,
      platform.Characteristic.On,
    );
  }

  // Get the current state of the light
  private async getLightState(): Promise<CharacteristicValue> {
    this.log.debug(`[${this.name}] Getting AC lighting state`);
    const deviceStatus = await this.getDeviceStatus();

    this.log.debug(`[${this.name}] Full device status for lighting: ${JSON.stringify(deviceStatus, null, 2)}`);

    // Harden the status read with optional chaining
    const cap = deviceStatus?.[CAP];
    const value = cap?.[ATTR]?.value as string | undefined;
    if (value === 'on') {
      return true;
    }
    if (value === 'off') {
      return false;
    }

    this.log.warn(`[${this.name}] ${CAP}.${ATTR} missing; defaulting to OFF`);
    return false;
  }

  // Set the light state
  private async setLightState(value: CharacteristicValue): Promise<void> {
    const cmd = value ? 'on' : 'off';
    this.log.info(`[${this.name}] Setting AC lighting to: ${cmd}`);
    await this.sendCommandsOrFail([new Command(CAP, cmd, [])]);
  }

  // Handle events from SmartThings
  public processEvent(event: ShortEvent): void {
    if (event.capability === CAP && event.attribute === ATTR) {
      const isOn = event.value === 'on';
      this.log.info(`[${this.name}] Event ${CAP}.${ATTR}=${event.value} -> ${isOn ? 'ON' : 'OFF'}`);
      this.service.updateCharacteristic(this.platform.Characteristic.On, isOn);
    }
  }

  // Helper method to get device status safely
  private async getDeviceStatus(): Promise<any> {
    this.multiServiceAccessory.forceNextStatusRefresh();
    if (!await this.getStatus()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.deviceStatus.status;
  }

  // Helper method to send commands or throw an error
  private async sendCommandsOrFail(commands: Command[]) {
    if (!this.multiServiceAccessory.isOnline) {
      this.log.error(`${this.name} is offline`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    if (!await this.multiServiceAccessory.sendCommands(commands)) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
