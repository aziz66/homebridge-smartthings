import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { IKHomeBridgeHomebridgePlatform } from '../platform';

/**
 * Volume Slider Service
 * Creates a separate lightbulb accessory for TV volume control because HomeKit's native TV interface 
 * doesn't show volume controls directly in the Home app.
 */
export class VolumeSliderService extends BaseService {
  private lastVolumeBeforeOff = 0;

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

    // Create the service as a Lightbulb (this makes it show as a slider in HomeKit)
    this.service = this.accessory.getService(`${name} Volume`) ||
      this.accessory.addService(this.platform.Service.Lightbulb, `${name} Volume`, 'VolumeSlider');

    // Set the display name
    this.service.setCharacteristic(this.platform.Characteristic.Name, `${name} Volume`);

    // Configure On/Off characteristic (represents mute state)
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    // Configure Brightness characteristic (represents volume level)
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      })
      .onGet(this.getBrightness.bind(this))
      .onSet(this.setBrightness.bind(this));

    // Start polling to keep slider synchronized with TV (like verified plugin)
    this.startSliderPolling();

    this.log.info(`🎚️ Volume Slider service created for ${this.name} component '${componentId}' (shows as lightbulb in HomeKit)`);
  }

  private startSliderPolling(): void {
    // Get TV-specific polling interval
    let pollInterval = 15000; // default 15 seconds for TVs
    if (this.platform.config.PollTelevisionsSeconds !== undefined) {
      pollInterval = this.platform.config.PollTelevisionsSeconds * 1000;
    }

    if (pollInterval > 0) {
      this.log.debug(`🎚️ Starting Volume Slider polling with ${pollInterval / 1000}s interval for ${this.name} (syncs with IR remote)`);
      
      // Poll On/Off state (mute status)
      setInterval(async () => {
        try {
          const onState = await this.getOn();
          this.service.updateCharacteristic(this.platform.Characteristic.On, onState);
        } catch (error) {
          this.log.error(`Error polling volume slider on/off for ${this.name}:`, error);
        }
      }, pollInterval);

      // Poll Brightness state (volume level)
      setInterval(async () => {
        try {
          const brightness = await this.getBrightness();
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
        } catch (error) {
          this.log.error(`Error polling volume slider brightness for ${this.name}:`, error);
        }
      }, pollInterval);
    }
  }

  // On/Off represents NOT muted (true = not muted, false = muted)
  private async getOn(): Promise<CharacteristicValue> {
    try {
      const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
      const muteState = (component?.status?.audioMute as any)?.mute?.value;
      const isNotMuted = muteState !== 'muted';
      this.log.debug(`Volume slider On state for ${this.name}: ${isNotMuted} (mute state: ${muteState})`);
      return isNotMuted;
    } catch (error) {
      this.log.debug(`Could not get mute state for volume slider ${this.name}, using cached value`);
      return true; // Default to not muted
    }
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Setting volume slider On state for ${this.name} to ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    if (value as boolean) {
      // Turning "on" means unmute and restore last volume
      if (this.lastVolumeBeforeOff > 0) {
        this.log.debug(`Restoring volume to ${this.lastVolumeBeforeOff} for ${this.name}`);
        await this.multiServiceAccessory.sendCommand('audioVolume', 'setVolume', [this.lastVolumeBeforeOff]);
      }
      await this.multiServiceAccessory.sendCommand('audioMute', 'unmute');
    } else {
      // Turning "off" means save current volume and mute
      this.lastVolumeBeforeOff = await this.getBrightness() as number;
      this.log.debug(`Saving volume ${this.lastVolumeBeforeOff} and muting ${this.name}`);
      await this.multiServiceAccessory.sendCommand('audioMute', 'mute');
    }

    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  // Brightness represents volume level (0-100)
  private async getBrightness(): Promise<CharacteristicValue> {
    try {
      const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
      const audioVolumeData = (component?.status?.audioVolume as any);
      const volume = audioVolumeData?.volume?.value;
      
      if (typeof volume === 'number') {
        this.log.debug(`Volume slider brightness for ${this.name}: ${volume} (from '${this.componentId}' component)`);
        return volume;
      } else {
        this.log.warn(`⚠️  No audioVolume data in '${this.componentId}' component for ${this.name} - available status:`, 
          Object.keys(component?.status || {}));
        return 0;
      }
    } catch (error) {
      this.log.debug(`Could not get volume for slider ${this.name}, using default`);
      return 0;
    }
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Setting volume slider brightness for ${this.name} to ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const volumeLevel = Math.max(0, Math.min(100, Math.round(Number(value))));
    
    // If setting volume above 0, automatically unmute
    if (volumeLevel > 0) {
      try {
        const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
        const muteState = (component?.status?.audioMute as any)?.mute?.value;
        
        if (muteState === 'muted') {
          this.log.debug(`Auto-unmuting before setting volume to ${volumeLevel} for ${this.name}`);
          await this.multiServiceAccessory.sendCommand('audioMute', 'unmute');
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (error) {
        this.log.debug(`Could not check mute state before volume change: ${error}`);
      }
    }

    this.log.info(`🔊 Setting volume via slider: ${volumeLevel}% for ${this.name}`);
    const success = await this.multiServiceAccessory.sendCommand('audioVolume', 'setVolume', [volumeLevel]);
    
    if (success) {
      this.log.info(`✅ Volume slider set successfully to ${volumeLevel}% for ${this.name}`);
      setTimeout(() => {
        this.multiServiceAccessory.forceNextStatusRefresh();
      }, 1000);
    } else {
      this.log.error(`❌ Volume slider command failed for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  public static getVolumeSliderCapabilities(): string[] {
    return ['audioVolume', 'audioMute'];
  }

  public static supportsVolumeSlider(capabilities: string[]): boolean {
    return capabilities.includes('audioVolume');
  }

  updateStatus(capability: string, status: any): void {
    this.log.debug(`Volume slider status update for ${this.name}: ${capability}`);
    
    try {
      switch (capability) {
        case 'audioVolume':
          if (status?.volume?.value !== undefined) {
            const volume = Number(status.volume.value);
            this.service.updateCharacteristic(this.platform.Characteristic.Brightness, volume);
            this.log.debug(`Volume slider updated to ${volume}% for ${this.name}`);
          }
          break;
        case 'audioMute':
          if (status?.mute?.value !== undefined) {
            const isNotMuted = status.mute.value !== 'muted';
            this.service.updateCharacteristic(this.platform.Characteristic.On, isNotMuted);
            this.log.debug(`Volume slider mute state updated to ${isNotMuted} for ${this.name}`);
          }
          break;
      }
    } catch (error) {
      this.log.error(`Error updating volume slider status for ${this.name}:`, error);
    }
  }
}
