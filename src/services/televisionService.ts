import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class TelevisionService extends BaseService {
  private televisionService: Service;
  private televisionSpeakerService: Service;
  private inputServices: Service[] = [];
  private inputSourcesMap: Array<{id: string; name: string}> = [];
  private currentInputSource = 1; // Default to first input
  private currentVolume = 0;
  private isMuted = false;

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

    this.log.debug(`Adding TelevisionService to ${this.name}`);

    // Setup the main Television service
    this.televisionService = this.setupTelevisionService();
    
    // Setup the Television Speaker service
    this.televisionSpeakerService = this.setupTelevisionSpeaker();
    
    // Setup Input Source services
    this.setupInputSources();

    // Configure the Television service as the primary service
    this.televisionService.setPrimaryService();

    // Link services together - TelevisionSpeaker and InputSources must be linked to Television
    this.televisionService.addLinkedService(this.televisionSpeakerService);
    this.inputServices.forEach(inputService => {
      this.televisionService.addLinkedService(inputService);
    });

    // Set the main service for BaseService compatibility
    this.service = this.televisionService;

    // Set the accessory category to Television for proper HomeKit presentation
    accessory.category = this.platform.api.hap.Categories.TELEVISION;

    // Start polling for updates
    this.startPolling();
  }

  private setupTelevisionService(): Service {
    const tvService = this.accessory.getService(this.platform.Service.Television) ||
      this.accessory.addService(this.platform.Service.Television, this.name, 'Television');

    // Set the display name
    tvService.setCharacteristic(this.platform.Characteristic.Name, this.name);

    // Configure the Active characteristic (power on/off)
    tvService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getTelevisionActive.bind(this))
      .onSet(this.setTelevisionActive.bind(this));

    // Configure Active Identifier (current input source)
    tvService.getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .onGet(this.getActiveIdentifier.bind(this))
      .onSet(this.setActiveIdentifier.bind(this));

    // Configure Configured Name (read-only)
    tvService.getCharacteristic(this.platform.Characteristic.ConfiguredName)
      .onGet(() => this.name);

    // Configure Sleep Discovery Mode (not supported by Samsung TVs typically)
    tvService.getCharacteristic(this.platform.Characteristic.SleepDiscoveryMode)
      .onGet(() => this.platform.Characteristic.SleepDiscoveryMode.NOT_DISCOVERABLE);

    // Configure Remote Key (for remote control commands)
    tvService.getCharacteristic(this.platform.Characteristic.RemoteKey)
      .onSet(this.setRemoteKey.bind(this));

    // Configure Picture Mode if supported
    if (this.isCapabilitySupported('custom.picturemode')) {
      tvService.getCharacteristic(this.platform.Characteristic.PictureMode)
        .onGet(this.getPictureMode.bind(this))
        .onSet(this.setPictureMode.bind(this));
    }

    return tvService;
  }

  private setupTelevisionSpeaker(): Service {
    const speakerService = this.accessory.getService(this.platform.Service.TelevisionSpeaker) ||
      this.accessory.addService(this.platform.Service.TelevisionSpeaker, `${this.name} Speaker`, 'TelevisionSpeaker');

    // Set the display name
    speakerService.setCharacteristic(this.platform.Characteristic.Name, `${this.name} Speaker`);

    // Configure Mute characteristic (required)
    speakerService.getCharacteristic(this.platform.Characteristic.Mute)
      .onGet(this.getMute.bind(this))
      .onSet(this.setMute.bind(this));

    // Configure Volume Control Type - specify what type of volume control is supported
    if (this.isCapabilitySupported('audioVolume')) {
      // TV supports absolute volume control
      speakerService.setCharacteristic(
        this.platform.Characteristic.VolumeControlType,
        this.platform.Characteristic.VolumeControlType.ABSOLUTE
      );

      // Add Volume characteristic for absolute volume control
      speakerService.getCharacteristic(this.platform.Characteristic.Volume)
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 1,
        })
        .onGet(this.getVolume.bind(this))
        .onSet(this.setVolume.bind(this));
    } else {
      // Fallback to relative volume control only
      speakerService.setCharacteristic(
        this.platform.Characteristic.VolumeControlType,
        this.platform.Characteristic.VolumeControlType.RELATIVE
      );
    }

    // Configure Volume Selector (for volume up/down commands) - always available
    speakerService.getCharacteristic(this.platform.Characteristic.VolumeSelector)
      .onSet(this.setVolumeSelector.bind(this));

    // Configure Active characteristic (speaker active state)
    speakerService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getSpeakerActive.bind(this))
      .onSet(this.setSpeakerActive.bind(this));

    return speakerService;
  }

  private setupInputSources(): void {
    // Get input sources from device status
    this.loadInputSources();

    // Create InputSource services for each input
    this.inputSourcesMap.forEach((input, index) => {
      const inputService = this.accessory.getService(`Input-${input.id}`) ||
        this.accessory.addService(
          this.platform.Service.InputSource,
          input.name,
          `Input-${input.id}`
        );

      // Configure the input source
      inputService
        .setCharacteristic(this.platform.Characteristic.Identifier, index + 1)
        .setCharacteristic(this.platform.Characteristic.ConfiguredName, input.name)
        .setCharacteristic(this.platform.Characteristic.IsConfigured, this.platform.Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(this.platform.Characteristic.InputSourceType, this.getInputSourceType(input.id))
        .setCharacteristic(this.platform.Characteristic.CurrentVisibilityState, this.platform.Characteristic.CurrentVisibilityState.SHOWN);

      // Configure visibility state (can be changed by user)
      inputService.getCharacteristic(this.platform.Characteristic.TargetVisibilityState)
        .onGet(() => this.platform.Characteristic.TargetVisibilityState.SHOWN)
        .onSet((value) => {
          // Handle input visibility changes if needed
          this.log.debug(`Input ${input.name} visibility changed to ${value}`);
        });

      this.inputServices.push(inputService);
    });
  }

  private loadInputSources(): void {
    // Try to load from Samsung's mediaInputSource capability from component status
    const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
    const inputSourceData = component?.status?.['samsungvd.mediaInputSource'] as any;
    
    if (inputSourceData?.supportedInputSourcesMap?.value) {
      this.inputSourcesMap = inputSourceData.supportedInputSourcesMap.value;
      this.log.debug(`Loaded ${this.inputSourcesMap.length} input sources for ${this.name}`);
    } else {
      // Fallback to common input sources if not available
      this.inputSourcesMap = [
        { id: 'dtv', name: 'TV' },
        { id: 'HDMI1', name: 'HDMI 1' },
        { id: 'HDMI2', name: 'HDMI 2' },
        { id: 'HDMI3', name: 'HDMI 3' },
        { id: 'HDMI4', name: 'HDMI 4' },
      ];
      this.log.debug(`Using fallback input sources for ${this.name}`);
    }
  }

  private getInputSourceType(inputId: string): number {
    // Map Samsung input IDs to HomeKit input source types
    const inputTypeMappings = {
      'dtv': this.platform.Characteristic.InputSourceType.TUNER,
      'HDMI1': this.platform.Characteristic.InputSourceType.HDMI,
      'HDMI2': this.platform.Characteristic.InputSourceType.HDMI,
      'HDMI3': this.platform.Characteristic.InputSourceType.HDMI,
      'HDMI4': this.platform.Characteristic.InputSourceType.HDMI,
      'USB': this.platform.Characteristic.InputSourceType.USB,
      'COMPONENT': this.platform.Characteristic.InputSourceType.COMPONENT_VIDEO,
      'COMPOSITE': this.platform.Characteristic.InputSourceType.COMPOSITE_VIDEO,
    };

    return inputTypeMappings[inputId] || this.platform.Characteristic.InputSourceType.OTHER;
  }

  private isCapabilitySupported(capability: string): boolean {
    return this.capabilities.includes(capability);
  }

  private startPolling(): void {
    // Poll for TV state updates - use TV-specific polling interval or fall back to switches/lights interval
    let pollSeconds = 15; // default for TVs
    if (this.platform.config.PollTelevisionsSeconds !== undefined) {
      pollSeconds = this.platform.config.PollTelevisionsSeconds;
    } else if (this.platform.config.PollSwitchesAndLightsSeconds !== undefined) {
      pollSeconds = this.platform.config.PollSwitchesAndLightsSeconds;
    }

    if (pollSeconds > 0) {
      this.multiServiceAccessory.startPollingState(
        pollSeconds,
        this.getTelevisionActive.bind(this),
        this.televisionService,
        this.platform.Characteristic.Active,
      );
    }
  }

  // Television Active (Power) Methods
  private async getTelevisionActive(): Promise<CharacteristicValue> {
    this.log.debug(`Getting TV active state for ${this.name}`);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          try {
            const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
            const switchData = component?.status?.switch as any;
            const switchState = switchData?.switch?.value;
            const isActive = switchState === 'on';
            this.log.debug(`TV active state for ${this.name}: ${isActive}`);
            resolve(isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
          } catch (error) {
            this.log.error(`Error getting TV active state for ${this.name}:`, error);
            reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          }
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  private async setTelevisionActive(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Setting TV active state for ${this.name} to ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(`${this.name} is offline`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const command = value === this.platform.Characteristic.Active.ACTIVE ? 'on' : 'off';
    const success = await this.multiServiceAccessory.sendCommand('switch', command);
    
    if (success) {
      this.log.debug(`TV power ${command} successful for ${this.name}`);
      this.multiServiceAccessory.forceNextStatusRefresh();
    } else {
      this.log.error(`TV power command failed for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // Active Identifier (Input Source) Methods
  private async getActiveIdentifier(): Promise<CharacteristicValue> {
    this.log.debug(`Getting active input for ${this.name}`);

    return new Promise((resolve) => {
      this.getStatus().then(success => {
        if (success) {
          try {
            // Try to get current input from Samsung's mediaInputSource capability
            const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
            const mediaInputData = component?.status?.['samsungvd.mediaInputSource'] as any;
            const currentInput = mediaInputData?.inputSource?.value;
            if (currentInput) {
              const inputIndex = this.inputSourcesMap.findIndex(input => input.id === currentInput);
              this.currentInputSource = inputIndex >= 0 ? inputIndex + 1 : 1;
            }
            this.log.debug(`Active input identifier for ${this.name}: ${this.currentInputSource}`);
            resolve(this.currentInputSource);
          } catch (error) {
            this.log.debug(`Could not determine active input for ${this.name}, using default`);
            resolve(this.currentInputSource);
          }
        } else {
          resolve(this.currentInputSource);
        }
      });
    });
  }

  private async setActiveIdentifier(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Setting active input for ${this.name} to ${value}`);

    const inputIndex = Number(value) - 1;
    if (inputIndex >= 0 && inputIndex < this.inputSourcesMap.length) {
      const targetInput = this.inputSourcesMap[inputIndex];
      
      if (!this.multiServiceAccessory.isOnline()) {
        this.log.error(`${this.name} is offline`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }

      // Send input source change command to Samsung TV
      const success = await this.multiServiceAccessory.sendCommand('samsungvd.mediaInputSource', 'setInputSource', [targetInput.id]);
      
      if (success) {
        this.currentInputSource = Number(value);
        this.log.debug(`Input source changed to ${targetInput.name} for ${this.name}`);
        this.multiServiceAccessory.forceNextStatusRefresh();
      } else {
        this.log.error(`Failed to change input source for ${this.name}`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } else {
      this.log.error(`Invalid input identifier ${value} for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }

  // Remote Key Methods
  private async setRemoteKey(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Received remote key command for ${this.name}: ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(`${this.name} is offline`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    // Map HomeKit remote keys to Samsung TV commands
    let command = '';
    let capability = '';
    
    switch (value) {
      case this.platform.Characteristic.RemoteKey.REWIND:
        capability = 'mediaPlayback';
        command = 'rewind';
        break;
      case this.platform.Characteristic.RemoteKey.FAST_FORWARD:
        capability = 'mediaPlayback';
        command = 'fastForward';
        break;
      case this.platform.Characteristic.RemoteKey.NEXT_TRACK:
        // Samsung TVs don't typically support track navigation, but we can try channel up
        capability = 'tvChannel';
        command = 'channelUp';
        break;
      case this.platform.Characteristic.RemoteKey.PREVIOUS_TRACK:
        capability = 'tvChannel';
        command = 'channelDown';
        break;
      case this.platform.Characteristic.RemoteKey.ARROW_UP:
      case this.platform.Characteristic.RemoteKey.ARROW_DOWN:
      case this.platform.Characteristic.RemoteKey.ARROW_LEFT:
      case this.platform.Characteristic.RemoteKey.ARROW_RIGHT:
      case this.platform.Characteristic.RemoteKey.SELECT:
      case this.platform.Characteristic.RemoteKey.BACK:
      case this.platform.Characteristic.RemoteKey.EXIT:
      case this.platform.Characteristic.RemoteKey.PLAY_PAUSE:
        // These would require Samsung's custom remote control capabilities
        this.log.debug(`Remote key ${value} not implemented for Samsung TV`);
        return;
      case this.platform.Characteristic.RemoteKey.INFORMATION:
        // Could potentially map to info button
        this.log.debug(`Information key pressed for ${this.name}`);
        return;
    }

    if (command && capability) {
      try {
        const success = await this.multiServiceAccessory.sendCommand(capability, command);
        if (success) {
          this.log.debug(`Remote key command ${command} successful for ${this.name}`);
        } else {
          this.log.error(`Remote key command ${command} failed for ${this.name}`);
        }
      } catch (error) {
        this.log.error(`Error sending remote key command for ${this.name}:`, error);
      }
    }
  }

  // Picture Mode Methods
  private async getPictureMode(): Promise<CharacteristicValue> {
    this.log.debug(`Getting picture mode for ${this.name}`);

    return new Promise((resolve) => {
      this.getStatus().then(success => {
        if (success) {
          try {
            const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
            const pictureModeData = component?.status?.['custom.picturemode'] as any;
            const pictureMode = pictureModeData?.pictureMode?.value;
            if (pictureMode) {
              // Map Samsung picture modes to HomeKit values
              const pictureModeMap = {
                'Standard': this.platform.Characteristic.PictureMode.STANDARD,
                'Dynamic': this.platform.Characteristic.PictureMode.VIVID,
                'Movie (Calibrated)': this.platform.Characteristic.PictureMode.STANDARD, // Fallback to STANDARD
                'FILMMAKER MODE': this.platform.Characteristic.PictureMode.STANDARD, // Fallback to STANDARD
                'Eco': this.platform.Characteristic.PictureMode.STANDARD,
              };
              const homekitMode = pictureModeMap[pictureMode] || this.platform.Characteristic.PictureMode.STANDARD;
              this.log.debug(`Picture mode for ${this.name}: ${pictureMode} -> ${homekitMode}`);
              resolve(homekitMode);
            } else {
              resolve(this.platform.Characteristic.PictureMode.STANDARD);
            }
          } catch (error) {
            this.log.debug(`Could not get picture mode for ${this.name}, using default`);
            resolve(this.platform.Characteristic.PictureMode.STANDARD);
          }
        } else {
          resolve(this.platform.Characteristic.PictureMode.STANDARD);
        }
      });
    });
  }

  private async setPictureMode(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Setting picture mode for ${this.name} to ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    // Map HomeKit picture modes back to Samsung modes
    const reversePictureModeMap = {
      [this.platform.Characteristic.PictureMode.STANDARD]: 'Standard',
      [this.platform.Characteristic.PictureMode.VIVID]: 'Dynamic',
    };

    const samsungMode = reversePictureModeMap[Number(value)];
    if (samsungMode) {
      const success = await this.multiServiceAccessory.sendCommand('custom.picturemode', 'setPictureMode', [samsungMode]);
      if (success) {
        this.log.debug(`Picture mode changed to ${samsungMode} for ${this.name}`);
        this.multiServiceAccessory.forceNextStatusRefresh();
      } else {
        this.log.error(`Failed to change picture mode for ${this.name}`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }
  }

  // Speaker Methods
  private async getMute(): Promise<CharacteristicValue> {
    this.log.debug(`Getting mute state for ${this.name}`);

    return new Promise((resolve) => {
      this.getStatus().then(success => {
        if (success) {
          try {
            const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
            const audioMuteData = component?.status?.audioMute as any;
            const muteState = audioMuteData?.mute?.value;
            this.isMuted = muteState === 'muted';
            this.log.debug(`Mute state for ${this.name}: ${this.isMuted}`);
            resolve(this.isMuted);
          } catch (error) {
            this.log.debug(`Could not get mute state for ${this.name}, using cached value`);
            resolve(this.isMuted);
          }
        } else {
          resolve(this.isMuted);
        }
      });
    });
  }

  private async setMute(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Setting mute state for ${this.name} to ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const command = value ? 'mute' : 'unmute';
    const success = await this.multiServiceAccessory.sendCommand('audioMute', command);
    
    if (success) {
      this.isMuted = Boolean(value);
      this.log.debug(`Mute ${command} successful for ${this.name}`);
      this.multiServiceAccessory.forceNextStatusRefresh();
    } else {
      this.log.error(`Mute command failed for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async getVolume(): Promise<CharacteristicValue> {
    this.log.debug(`Getting volume for ${this.name}`);

    return new Promise((resolve) => {
      this.getStatus().then(success => {
        if (success) {
          try {
            const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
            const audioVolumeData = component?.status?.audioVolume as any;
            const volume = audioVolumeData?.volume?.value;
            if (typeof volume === 'number') {
              this.currentVolume = volume;
              this.log.debug(`Volume for ${this.name}: ${volume}`);
              resolve(volume);
            } else {
              resolve(this.currentVolume);
            }
          } catch (error) {
            this.log.debug(`Could not get volume for ${this.name}, using cached value`);
            resolve(this.currentVolume);
          }
        } else {
          resolve(this.currentVolume);
        }
      });
    });
  }

  private async setVolume(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Setting volume for ${this.name} to ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const volumeLevel = Number(value);
    const success = await this.multiServiceAccessory.sendCommand('audioVolume', 'setVolume', [volumeLevel]);
    
    if (success) {
      this.currentVolume = volumeLevel;
      this.log.debug(`Volume set to ${volumeLevel} for ${this.name}`);
      this.multiServiceAccessory.forceNextStatusRefresh();
    } else {
      this.log.error(`Volume command failed for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async setVolumeSelector(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Volume selector for ${this.name}: ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const command = value === this.platform.Characteristic.VolumeSelector.INCREMENT ? 'volumeUp' : 'volumeDown';
    const success = await this.multiServiceAccessory.sendCommand('audioVolume', command);
    
    if (success) {
      this.log.debug(`Volume ${command} successful for ${this.name}`);
      this.multiServiceAccessory.forceNextStatusRefresh();
    } else {
      this.log.error(`Volume ${command} failed for ${this.name}`);
    }
  }

  // Speaker Active Methods
  private async getSpeakerActive(): Promise<CharacteristicValue> {
    this.log.debug(`Getting speaker active state for ${this.name}`);
    
    // Speaker is active when TV is active and not muted
    const tvActive = await this.getTelevisionActive();
    const isMuted = await this.getMute();
    
    const speakerActive = tvActive === this.platform.Characteristic.Active.ACTIVE && !isMuted;
    return speakerActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  private async setSpeakerActive(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Setting speaker active state for ${this.name} to ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    // For speaker active/inactive, we control the mute state
    // Active = unmute, Inactive = mute
    const shouldMute = value === this.platform.Characteristic.Active.INACTIVE;
    await this.setMute(shouldMute);
  }

  // Event Processing
  public processEvent(event: ShortEvent): void {
    this.log.debug(`Processing event for TV ${this.name}: ${event.capability} = ${event.value}`);

    switch (event.capability) {
      case 'switch':
        const isActive = event.value === 'on';
        this.televisionService.updateCharacteristic(
          this.platform.Characteristic.Active,
          isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE
        );
        break;

      case 'audioMute':
        this.isMuted = event.value === 'muted';
        this.televisionSpeakerService.updateCharacteristic(
          this.platform.Characteristic.Mute,
          this.isMuted
        );
        // Update speaker active state based on mute status
        this.televisionSpeakerService.updateCharacteristic(
          this.platform.Characteristic.Active,
          !this.isMuted ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE
        );
        break;

      case 'audioVolume':
        if (typeof event.value === 'number') {
          this.currentVolume = event.value;
          if (this.televisionSpeakerService.testCharacteristic(this.platform.Characteristic.Volume)) {
            this.televisionSpeakerService.updateCharacteristic(
              this.platform.Characteristic.Volume,
              this.currentVolume
            );
          }
        }
        break;

      case 'samsungvd.mediaInputSource':
        if (event.attribute === 'inputSource') {
          const inputIndex = this.inputSourcesMap.findIndex(input => input.id === event.value);
          if (inputIndex >= 0) {
            this.currentInputSource = inputIndex + 1;
            this.televisionService.updateCharacteristic(
              this.platform.Characteristic.ActiveIdentifier,
              this.currentInputSource
            );
          }
        }
        break;

      case 'custom.picturemode':
        if (event.attribute === 'pictureMode' && this.televisionService.testCharacteristic(this.platform.Characteristic.PictureMode)) {
          // Update picture mode if the service supports it
          this.getPictureMode().then(mode => {
            this.televisionService.updateCharacteristic(this.platform.Characteristic.PictureMode, mode);
          });
        }
        break;

      default:
        this.log.debug(`Unhandled TV event capability: ${event.capability}`);
        break;
    }
  }

  // Static method to detect if a device is a TV
  public static isTelevisionDevice(device: any): boolean {
    // Check for Samsung TV-specific indicators
    const hasDeviceCategory = device.components?.some(component => 
      component.capabilities?.some(cap => cap.id === 'samsungvd.deviceCategory')
    );

    const hasMediaInput = device.components?.some(component => 
      component.capabilities?.some(cap => cap.id === 'samsungvd.mediaInputSource')
    );

    const hasAudioCapabilities = device.components?.some(component => 
      component.capabilities?.some(cap => cap.id === 'audioVolume' || cap.id === 'audioMute')
    );

    const hasTvChannel = device.components?.some(component => 
      component.capabilities?.some(cap => cap.id === 'tvChannel')
    );

    // A device is considered a TV if it has multiple TV-specific capabilities
    const tvIndicatorCount = [hasDeviceCategory, hasMediaInput, hasAudioCapabilities, hasTvChannel].filter(Boolean).length;
    
    return tvIndicatorCount >= 2; // Require at least 2 TV-specific capability groups
  }

  // Static method to get TV-related capabilities for the capability map
  public static getTvCapabilities(): string[] {
    return [
      'switch', // Power control
      'samsungvd.deviceCategory',
      'samsungvd.mediaInputSource',
      'audioVolume',
      'audioMute',
      'tvChannel',
      'mediaPlayback',
      'custom.picturemode',
      'custom.soundmode'
    ];
  }
}
