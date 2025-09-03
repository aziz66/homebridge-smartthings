import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { IKHomeBridgeHomebridgePlatform } from '../platform';

/**
 * Volume Slider Service (Within Same TV Accessory)
 * Creates a lightbulb service within the TV accessory for volume control.
 * This ensures the volume slider appears in the same HomeKit tile as the TV.
 * 
 * The slider appears as a lightbulb because iOS doesn't support direct volume sliders.
 * Brightness = Volume (0-100%), On/Off = Mute state (inverted: On = NOT muted)
 */
export class VolumeSliderService extends BaseService {
  protected service: Service;
  private lastVolumeBeforeOff = 0;
  private pollInterval: NodeJS.Timeout | undefined;

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
    componentId: string,
    capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string,
    deviceStatus: any,
  ) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    // Create the service as a Lightbulb within the same TV accessory
    this.service = this.accessory.getService(`${name} Volume`) ||
      this.accessory.addService(this.platform.Service.Lightbulb, `${name} Volume`, 'VolumeSlider');

    // Set the display name
    this.service.setCharacteristic(this.platform.Characteristic.Name, `${name} Volume`);

    // Configure On/Off characteristic (represents NOT muted - inverted logic)
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    // Configure Brightness characteristic (represents volume level 0-100)
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      })
      .onGet(this.getBrightness.bind(this))
      .onSet(this.setBrightness.bind(this));

    // Start polling to keep slider synchronized with TV IR remote changes
    this.startSliderPolling();

    this.log.info(`🎚️ Volume Slider service created within ${this.name} TV tile (component: ${componentId})`);
  }

  private startSliderPolling(): void {
    // Get TV-specific polling interval
    let pollInterval = 15000; // default 15 seconds for TVs
    if (this.platform.config.PollTelevisionsSeconds && this.platform.config.PollTelevisionsSeconds > 0) {
      pollInterval = this.platform.config.PollTelevisionsSeconds * 1000;
    }

    this.log.info(`🎚️ Starting Volume Slider polling with ${pollInterval/1000}s interval for ${this.name} (syncs with IR remote)`);

    this.pollInterval = setInterval(async () => {
      try {
        this.log.debug(`🔄 Volume slider polling for ${this.name}...`);
        
        // Force refresh of device status first to get latest data
        await this.multiServiceAccessory.refreshStatus();
        
        // Then poll both On (mute) and Brightness (volume) to sync with IR remote changes
        const onValue = await this.getOn();
        const brightnessValue = await this.getBrightness();

        this.service.updateCharacteristic(this.platform.Characteristic.On, onValue);
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightnessValue);
      } catch (error) {
        this.log.debug(`Volume slider polling error for ${this.name}:`, error);
      }
    }, pollInterval);
  }

  /**
   * Get On state (represents NOT muted - inverted logic)
   * On = true means NOT muted, On = false means muted
   */
  private async getOn(): Promise<CharacteristicValue> {
    try {
      // Get fresh status directly from SmartThings API for the main component
      const response = await this.platform.axInstance.get(`devices/${this.accessory.context.device.deviceId}/components/main/capabilities/audioMute/status`);
      const muteValue = response.data?.mute?.value;
      
      const isNotMuted = muteValue !== 'muted';
      this.log.debug(`Volume slider On state for ${this.name}: ${isNotMuted} (mute: ${muteValue}) from main component`);
      return isNotMuted;
    } catch (error) {
      this.log.debug(`Could not get mute state for slider ${this.name}:`, error);
      return true; // Default to not muted
    }
  }

  /**
   * Set On state (toggle mute)
   * On = true means unmute, On = false means mute
   */
  private async setOn(value: CharacteristicValue): Promise<void> {
    try {
      if (value as boolean) {
        // Turning on = unmute
        this.log.debug(`Volume slider turning ON (unmuting) ${this.name}`);
        await this.platform.axInstance.post(`devices/${this.accessory.context.device.deviceId}/commands`, {
          commands: [{
            component: 'main', // Always target main component
            capability: 'audioMute',
            command: 'unmute',
          }],
        });
        this.log.info(`✅ Volume slider unmuted successfully for ${this.name}`);
      } else {
        // Turning off = mute
        this.log.debug(`Volume slider turning OFF (muting) ${this.name}`);
        await this.platform.axInstance.post(`devices/${this.accessory.context.device.deviceId}/commands`, {
          commands: [{
            component: 'main', // Always target main component
            capability: 'audioMute',
            command: 'mute',
          }],
        });
        this.log.info(`✅ Volume slider muted successfully for ${this.name}`);
      }

      // Update our characteristics immediately with fresh API calls (bypass cached status)
      setTimeout(async () => {
        try {
          this.log.debug(`🔄 Refreshing volume slider state after mute command for ${this.name}`);
          const onValue = await this.getOn(); // This makes a fresh API call
          this.service.updateCharacteristic(this.platform.Characteristic.On, onValue);
        } catch (error) {
          this.log.debug(`Status refresh after mute toggle failed for ${this.name}:`, error);
        }
      }, 2000); // Allow time for SmartThings to process the command

    } catch (error) {
      this.log.error(`❌ Failed to set mute state for volume slider ${this.name}:`, error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Get Brightness (represents volume level 0-100)
   */
  private async getBrightness(): Promise<CharacteristicValue> {
    try {
      // Get fresh status directly from SmartThings API for the main component
      const response = await this.platform.axInstance.get(`devices/${this.accessory.context.device.deviceId}/components/main/capabilities/audioVolume/status`);
      const volume = response.data?.volume?.value;

      if (typeof volume === 'number') {
        const boundedVolume = Math.max(0, Math.min(100, volume)); // Bound between 0-100
        this.log.debug(`Volume slider brightness for ${this.name}: ${boundedVolume}% (from main component)`);
        return boundedVolume;
      } else {
        this.log.warn(`⚠️  No audioVolume data in main component for ${this.name} - API response:`, response.data);
        return 0;
      }
    } catch (error) {
      this.log.debug(`Could not get volume for slider ${this.name}:`, error);
      return 0;
    }
  }

  /**
   * Set Brightness (set volume level 0-100)
   */
  private async setBrightness(value: CharacteristicValue): Promise<void> {
    try {
      const volume = Math.max(0, Math.min(100, value as number)); // Bound between 0-100
      
      this.log.debug(`Volume slider setting brightness to ${volume}% for ${this.name}`);
      
      // Set volume using SmartThings API to main component
      await this.platform.axInstance.post(`devices/${this.accessory.context.device.deviceId}/commands`, {
        commands: [{
          component: 'main', // Always target main component
          capability: 'audioVolume',
          command: 'setVolume',
          arguments: [volume],
        }],
      });

      // If setting volume above 0 and TV is muted, automatically unmute
      if (volume > 0) {
        try {
          const response = await this.platform.axInstance.get(`devices/${this.accessory.context.device.deviceId}/components/main/capabilities/audioMute/status`);
          const muteValue = response.data?.mute?.value;
          
          if (muteValue === 'muted') {
            this.log.debug(`Auto-unmuting ${this.name} because volume was set to ${volume}%`);
            await this.platform.axInstance.post(`devices/${this.accessory.context.device.deviceId}/commands`, {
              commands: [{
                component: 'main', // Always target main component
                capability: 'audioMute',
                command: 'unmute',
              }],
            });
          }
        } catch (error) {
          this.log.debug(`Could not check/set mute state during volume change for ${this.name}:`, error);
        }
      }

      this.log.info(`✅ Volume slider set successfully to ${volume}% for ${this.name}`);

      // Update our characteristics immediately with fresh API calls (bypass cached status)
      setTimeout(async () => {
        try {
          this.log.debug(`🔄 Refreshing volume slider state after volume command for ${this.name}`);
          const brightnessValue = await this.getBrightness(); // This makes a fresh API call
          const onValue = await this.getOn(); // This makes a fresh API call
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightnessValue);
          this.service.updateCharacteristic(this.platform.Characteristic.On, onValue);
        } catch (error) {
          this.log.debug(`Status refresh after volume change failed for ${this.name}:`, error);
        }
      }, 2000); // Allow time for SmartThings to process the command

    } catch (error) {
      this.log.error(`❌ Failed to set volume for slider ${this.name}:`, error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Returns the capabilities that this service can handle
   */
  public static getVolumeSliderCapabilities(): string[] {
    return ['audioVolume', 'audioMute'];
  }

  /**
   * Check if the given capabilities support volume slider functionality
   */
  public static supportsVolumeSlider(capabilities: string[]): boolean {
    return capabilities.includes('audioVolume') || capabilities.includes('audioMute');
  }

  /**
   * Cleanup method to stop polling when accessory is removed
   */
  public cleanup(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
      this.log.debug(`Volume slider polling stopped for ${this.name}`);
    }
  }
}