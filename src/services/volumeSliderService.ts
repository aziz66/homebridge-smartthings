import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { ShortEvent } from '../webhook/subscriptionHandler';

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
        
        // Use the proper status mechanism instead of direct API calls
        if (await this.getStatus()) {
          // Update characteristics from device status
          const onValue = await this.getOn();
          const brightnessValue = await this.getBrightness();

          this.service.updateCharacteristic(this.platform.Characteristic.On, onValue);
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightnessValue);
        }
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
    return new Promise((resolve) => {
      this.getStatus().then(success => {
        if (!success) {
          this.log.debug(`Could not get status for mute check on ${this.name}`);
          resolve(true); // Default to not muted if we can't get status
        } else {
          try {
            // Get mute status from device status (main component)
            const muteValue = this.deviceStatus.status?.main?.audioMute?.mute?.value;
            const isNotMuted = muteValue !== 'muted';
            this.log.debug(`Volume slider On state for ${this.name}: ${isNotMuted} (mute: ${muteValue}) from main component`);
            resolve(isNotMuted);
          } catch (error) {
            this.log.debug(`Error parsing mute status for ${this.name}:`, error);
            resolve(true); // Default to not muted
          }
        }
      });
    });
  }

  /**
   * Set On state (toggle mute)
   * On = true means unmute, On = false means mute
   */
  private async setOn(value: CharacteristicValue): Promise<void> {
    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(`${this.name} is offline`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const command = value as boolean ? 'unmute' : 'mute';
    this.log.debug(`Volume slider turning ${value ? 'ON (unmuting)' : 'OFF (muting)'} ${this.name}`);
    
    const success = await this.multiServiceAccessory.sendCommand('audioMute', command);
    
    if (success) {
      this.log.info(`✅ Volume slider ${command}d successfully for ${this.name}`);
      // Force a status refresh after a delay to get updated values
      setTimeout(() => {
        this.multiServiceAccessory.forceNextStatusRefresh();
      }, 1000);
    } else {
      this.log.error(`❌ Failed to ${command} volume slider for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Get Brightness (represents volume level 0-100)
   */
  private async getBrightness(): Promise<CharacteristicValue> {
    return new Promise((resolve) => {
      this.getStatus().then(success => {
        if (!success) {
          this.log.debug(`Could not get status for volume check on ${this.name}`);
          resolve(0); // Default to 0 volume if we can't get status
        } else {
          try {
            // Get volume from device status (main component)
            const volume = this.deviceStatus.status?.main?.audioVolume?.volume?.value;
            
            if (typeof volume === 'number') {
              const boundedVolume = Math.max(0, Math.min(100, volume)); // Bound between 0-100
              this.log.debug(`Volume slider brightness for ${this.name}: ${boundedVolume}% (from main component)`);
              resolve(boundedVolume);
            } else {
              this.log.warn(`⚠️  No audioVolume data in main component for ${this.name}`);
              resolve(0);
            }
          } catch (error) {
            this.log.debug(`Error parsing volume status for ${this.name}:`, error);
            resolve(0); // Default to 0 volume
          }
        }
      });
    });
  }

  /**
   * Set Brightness (set volume level 0-100)
   */
  private async setBrightness(value: CharacteristicValue): Promise<void> {
    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(`${this.name} is offline`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const volume = Math.max(0, Math.min(100, value as number)); // Bound between 0-100
    this.log.debug(`Volume slider setting brightness to ${volume}% for ${this.name}`);
    
    // Set volume using proper command mechanism
    const success = await this.multiServiceAccessory.sendCommand('audioVolume', 'setVolume', [volume]);
    
    if (success) {
      this.log.info(`✅ Volume slider set successfully to ${volume}% for ${this.name}`);
      
      // If setting volume above 0 and TV is muted, automatically unmute
      if (volume > 0) {
        try {
          // Check current mute status from device status
          if (await this.getStatus()) {
            const muteValue = this.deviceStatus.status?.main?.audioMute?.mute?.value;
            
            if (muteValue === 'muted') {
              this.log.debug(`Auto-unmuting ${this.name} because volume was set to ${volume}%`);
              await this.multiServiceAccessory.sendCommand('audioMute', 'unmute');
            }
          }
        } catch (error) {
          this.log.debug(`Could not check/set mute state during volume change for ${this.name}:`, error);
        }
      }

      // Force a status refresh after a delay to get updated values
      setTimeout(() => {
        this.multiServiceAccessory.forceNextStatusRefresh();
      }, 1000);
    } else {
      this.log.error(`❌ Failed to set volume for slider ${this.name}`);
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
   * Process webhook events for real-time updates
   */
  public processEvent(event: ShortEvent): void {
    this.log.debug(`Volume slider received event for ${this.name}: ${event.capability}.${event.attribute} = ${event.value}`);
    
    try {
      if (event.capability === 'audioMute' && event.attribute === 'mute') {
        const isNotMuted = event.value !== 'muted';
        this.service.updateCharacteristic(this.platform.Characteristic.On, isNotMuted);
        this.log.debug(`Volume slider mute state updated via webhook for ${this.name}: ${isNotMuted}`);
      } else if (event.capability === 'audioVolume' && event.attribute === 'volume') {
        const volume = Math.max(0, Math.min(100, Number(event.value) || 0));
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, volume);
        this.log.debug(`Volume slider volume updated via webhook for ${this.name}: ${volume}%`);
      }
    } catch (error) {
      this.log.debug(`Error processing event for volume slider ${this.name}:`, error);
    }
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