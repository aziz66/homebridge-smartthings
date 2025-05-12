import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Command } from './smartThingsCommand';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { BaseService } from './baseService';

enum LightState {
  On = 'on',
  Off = 'off'
}

export class ACLightingService extends BaseService {
  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
    componentId: string,
    capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string,
    deviceStatus
  ) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);
    
    this.log.debug(`Adding ACLightingService to ${this.name} for component ${componentId}`);
    this.log.debug(`ACLightingService capabilities: ${JSON.stringify(capabilities)}`);
    this.log.debug(`Device status contains lighting capability: ${JSON.stringify(deviceStatus?.['samsungce.airConditionerLighting'], null, 2)}`);
    
    // Add a Lightbulb service for the Samsung AC lighting
    this.setServiceType(platform.Service.Lightbulb);
    
    // Set the display name for this service
    this.service.setCharacteristic(platform.Characteristic.Name, `${this.name} Light`);
    
    // Configure the On/Off characteristic
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getLightState.bind(this))
      .onSet(this.setLightState.bind(this));
    
    // Start polling to keep the state updated
    multiServiceAccessory.startPollingState(
      this.platform.config.PollSwitchesAndLightsSeconds,
      this.getLightState.bind(this),
      this.service,
      platform.Characteristic.On
    );
  }
  
  // Get the current state of the light
  private async getLightState(): Promise<CharacteristicValue> {
    this.log.debug(`[${this.name}] Getting AC lighting state`);
    const deviceStatus = await this.getDeviceStatus();
    
    this.log.debug(`[${this.name}] Full device status for lighting: ${JSON.stringify(deviceStatus, null, 2)}`);
    
    // Check if the lighting capability exists and has a value
    if (deviceStatus['samsungce.airConditionerLighting'] && 
        deviceStatus['samsungce.airConditionerLighting'].lighting) {
      const lightState = deviceStatus['samsungce.airConditionerLighting'].lighting.value;
      this.log.debug(`[${this.name}] Current AC lighting state: ${lightState}`);
      return lightState === LightState.On;
    }
    
    this.log.warn(`[${this.name}] AC lighting state not found in device status`);
    return false; // Default to off if we can't determine the state
  }
  
  // Set the light state
  private async setLightState(value: CharacteristicValue): Promise<void> {
    const lightState = value ? LightState.On : LightState.Off;
    this.log.info(`[${this.name}] Setting AC lighting to: ${lightState}`);
    
    // Send the command to SmartThings
    await this.sendCommandsOrFail([
      new Command("samsungce.airConditionerLighting", lightState),
    ]);
  }
  
  // Handle events from SmartThings
  public processEvent(event: ShortEvent): void {
    if (event.capability === 'samsungce.airConditionerLighting') {
      this.log.info(`[${this.name}] Received AC lighting event: ${JSON.stringify(event, null, 2)}`);
      const isOn = event.value === LightState.On;
      this.log.info(`[${this.name}] Updating HomeKit lighting state to: ${isOn ? 'ON' : 'OFF'}`);
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