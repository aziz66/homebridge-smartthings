import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { SamsungWebSocket } from '../local/samsungWebSocket';

export class TelevisionService extends BaseService {
  // Predefined Samsung TV app catalog: appId -> display name
  private static readonly AVAILABLE_APPS: Record<string, string> = {
    '3201907018807': 'Netflix',
    '3201910019365': 'Prime Video',
    '111299001912': 'YouTube',
    '3201611010983': 'YouTube Kids',
    '3201606009684': 'Spotify',
    '3201901017640': 'Disney+',
    '3201601007625': 'Hulu',
    '3201710014981': 'Paramount+',
    '3201807016597': 'Apple TV',
    '3202006020991': 'Peacock TV',
    '3201710015037': 'Gallery',
    '3202301029760': 'HBO Max',
    '111477000821': 'Shahid',
    '3201608010191': 'Deezer',
    '3201806016390': 'DAZN',
    '3201708014618': 'ESPN',
    '3202410037239': 'BeIN Sports',
    '3201908019041': 'Apple Music',
  };

  // Frame TV support: optional WebSocket for local control
  private samsungWebSocket: SamsungWebSocket | null = null;
  private enableFullPowerOff = false;
  private artSupportChecked = false;
  private televisionService: Service;
  private televisionSpeakerService: Service;
  private inputServices: Service[] = [];
  private inputSourcesMap: Array<{id: string; name: string}> = [];
  private appIds: Set<string> = new Set(); // Track which input sources are apps
  private currentInputSource = 1; // Default to first input
  private currentVolume = 0;
  private isMuted = false;
  private lastKnownInputSourcesHash = ''; // Track changes to input sources

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

    // Setup the Television Speaker service (if not using separate volume slider)
    const hasVolumeSlider = this.platform.config.registerVolumeSlider === true;
    this.televisionSpeakerService = this.setupTelevisionSpeaker(hasVolumeSlider);

    // Setup Input Source services (will be completed during capability registration)
    // Note: Input sources are loaded asynchronously when samsungvd.mediaInputSource capability is registered

    // Configure the Television service as the primary service
    this.televisionService.setPrimaryService();

    // Link services together - TelevisionSpeaker must be linked to Television
    // Note: InputSources will be linked individually when they are registered asynchronously
    this.televisionService.addLinkedService(this.televisionSpeakerService);

    // Set the main service for BaseService compatibility
    this.service = this.televisionService;

    // Set the accessory category to Television for proper HomeKit presentation
    accessory.category = this.platform.api.hap.Categories.TELEVISION;

    // Setup characteristic polling (will be started when capabilities are registered)
    this.setupCharacteristicPolling();
  }

  /**
   * Configure this TV for Frame TV local WebSocket control.
   * When set, power-off commands will use a 3.5s hold of KEY_POWER via WebSocket.
   */
  public setFrameTvWebSocket(ws: SamsungWebSocket, enableFullPowerOff: boolean): void {
    this.samsungWebSocket = ws;
    this.enableFullPowerOff = enableFullPowerOff;
    this.log.info(`Frame TV: Local WebSocket configured for ${this.name} (fullPowerOff=${enableFullPowerOff})`);
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

  private setupTelevisionSpeaker(hasVolumeSlider = false): Service {
    const speakerService = this.accessory.getService(this.platform.Service.TelevisionSpeaker) ||
      this.accessory.addService(this.platform.Service.TelevisionSpeaker, `${this.name} Speaker`, 'TelevisionSpeaker');

    // Set the display name
    speakerService.setCharacteristic(this.platform.Characteristic.Name, `${this.name} Speaker`);

    if (hasVolumeSlider) {
      // Volume Slider is enabled - TelevisionSpeaker provides NO volume controls to avoid conflicts
      this.log.info(`🎚️ Volume Slider enabled - TelevisionSpeaker disabled to prevent conflicts for ${this.name}`);

      // Don't register any volume/mute characteristics when volume slider is enabled
      // This completely avoids conflicts with the separate volume slider accessory

    } else {
      // Standard TelevisionSpeaker with full volume/mute controls
      this.log.info(`🔊 Standard TelevisionSpeaker mode for ${this.name} (full volume/mute controls)`);

      // Configure Mute characteristic
      if (this.isCapabilitySupported('audioMute')) {
        speakerService.getCharacteristic(this.platform.Characteristic.Mute)
          .onGet(this.getMute.bind(this))
          .onSet(this.setMute.bind(this));

        // Mute updates will come from global status polling and webhook events
      }

      // Configure Volume Control Type and characteristics
      if (this.isCapabilitySupported('audioVolume')) {
        // TV supports absolute volume control
        speakerService.setCharacteristic(
          this.platform.Characteristic.VolumeControlType,
          this.platform.Characteristic.VolumeControlType.ABSOLUTE,
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

        // Volume updates will come from global status polling and webhook events
      } else {
        // Fallback to relative volume control only
        speakerService.setCharacteristic(
          this.platform.Characteristic.VolumeControlType,
          this.platform.Characteristic.VolumeControlType.RELATIVE,
        );
      }

      // Configure Volume Selector (for volume up/down commands)
      speakerService.getCharacteristic(this.platform.Characteristic.VolumeSelector)
        .onSet(this.setVolumeSelector.bind(this));
    }

    // Configure Active characteristic (speaker is always active when TV service exists - per verified plugin)
    speakerService.setCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);

    return speakerService;
  }

  private setupCharacteristicPolling(): void {
    // Characteristic polling will be set up individually when each capability is detected
    // This matches the verified plugin's approach of polling per capability
    this.log.debug(`Characteristic polling setup completed for ${this.name}`);
  }

  // Volume and mute polling removed - now uses global status polling and webhook events

  private async setupInputSources(): Promise<void> {
    // Register physical input sources (HDMI, DTV, etc.) with custom TV names
    await this.registerPhysicalInputSources();
    // Register app input sources (Netflix, YouTube, etc.) from config
    this.registerAppInputSources();
  }

  private async registerPhysicalInputSources(): Promise<void> {
    this.log.info(`📺 Registering physical input sources for ${this.name}`);

    // Load input sources with custom TV names (async API call)
    await this.loadInputSources();

    // Create InputSource services for each physical input
    this.inputSourcesMap.forEach((input, index) => {
      this.registerInputSource(
        input.id,    // SmartThings ID (e.g., "HDMI1", "dtv")
        input.name,  // Custom TV name (e.g., "PlayStation 5", "Apple TV")
        this.getInputSourceType(input.id),
      );

      this.log.info(`   📺 Physical Input: "${input.name}" (${input.id}) -> HomeKit ID ${index + 1}`);
    });

    this.log.info(`📺 Successfully registered ${this.inputSourcesMap.length} input sources for ${this.name}`);
  }

  private registerAppInputSources(): void {
    const tvApps: string[] = this.platform.config.tvApps ?? [];

    if (!Array.isArray(tvApps) || tvApps.length === 0) {
      this.log.debug(`No TV apps configured for ${this.name}`);
      return;
    }

    this.log.info(`📱 Registering ${tvApps.length} app input sources for ${this.name}`);

    for (const appId of tvApps) {
      const appName = TelevisionService.AVAILABLE_APPS[appId];
      if (!appName) {
        this.log.debug(`Skipping unknown app ID "${appId}" - not in AVAILABLE_APPS catalog`);
        continue;
      }

      this.registerInputSource(
        appId,
        appName,
        this.platform.Characteristic.InputSourceType.APPLICATION,
      );
      this.appIds.add(appId);
      this.inputSourcesMap.push({ id: appId, name: appName });

      this.log.info(`   📱 App Input: "${appName}" (${appId}) -> HomeKit ID ${this.inputServices.length}`);
    }

    this.log.info(`📱 Successfully registered ${this.appIds.size} app input sources for ${this.name}`);
  }

  private registerInputSource(id: string, name: string, inputSourceType: number): void {
    // Determine service subtype based on input source type
    const serviceSubtype = inputSourceType === this.platform.Characteristic.InputSourceType.APPLICATION
      ? `App-${id}`
      : `Input-${id}`;

    const inputService = this.accessory.getService(serviceSubtype) ||
      this.accessory.addService(
        this.platform.Service.InputSource,
        name,
        serviceSubtype,
      );

    // Set the service name to the SmartThings ID (used in commands)
    inputService.name = id;

    // Configure the input source
    inputService
      .setCharacteristic(this.platform.Characteristic.Identifier, this.inputServices.length + 1)
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, name)  // Custom display name
      .setCharacteristic(this.platform.Characteristic.IsConfigured, this.platform.Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(this.platform.Characteristic.InputSourceType, inputSourceType)
      .setCharacteristic(this.platform.Characteristic.CurrentVisibilityState, this.platform.Characteristic.CurrentVisibilityState.SHOWN);

    // Configure visibility state (user can hide/show inputs)
    inputService.getCharacteristic(this.platform.Characteristic.TargetVisibilityState)
      .onGet(() => this.platform.Characteristic.TargetVisibilityState.SHOWN)
      .onSet((value) => {
        inputService.setCharacteristic(this.platform.Characteristic.CurrentVisibilityState, value);
        const sourceType = inputSourceType === this.platform.Characteristic.InputSourceType.APPLICATION ? 'App' : 'Input';
        this.log.debug(`${sourceType} "${name}" visibility changed to ${value}`);
      });

    // Link to Television service and add to our list
    this.televisionService.addLinkedService(inputService);
    this.inputServices.push(inputService);
    this.log.debug(
      `✅ Registered input source "${name}" (${id}) with identifier ${this.inputServices.length} for ${this.accessory.displayName}`,
    );
  }

  // Method to be called when samsungvd.mediaInputSource capability becomes available
  public async registerInputSourceCapability(): Promise<void> {
    if (this.inputServices.length === 0) {
      this.log.info(`🔄 Input source capability available - registering input sources for ${this.name}`);
      await this.setupInputSources();

      // CRITICAL: Update HomeKit about the new input source services
      this.log.debug(
        `📱 Updating HomeKit with ${this.inputServices.length} new input sources for ${this.name}`,
      );
      this.platform.api.updatePlatformAccessories([this.accessory]);
    } else {
      this.log.debug(`Input sources already registered for ${this.name}`);
    }
  }

  private async loadInputSources(): Promise<void> {
    try {
      // CRITICAL: First refresh the device status to get fresh data (like verified plugin)
      this.log.debug(`🔄 Refreshing device status to get fresh input source data for ${this.name}`);
      await this.multiServiceAccessory.refreshStatus();

      // Now access the fresh status data from component
      const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
      const inputSourceData = component?.status?.['samsungvd.mediaInputSource'] as any;

      if (inputSourceData?.supportedInputSourcesMap?.value) {
        // Use Samsung TV's current custom input names (fresh from API)
        const supportedInputSources = inputSourceData.supportedInputSourcesMap.value as { id: string; name: string }[];

        // Remove duplicates and ensure unique input source IDs
        const uniqueInputSources = supportedInputSources.reduce((acc: { id: string; name: string }[], current) => {
          const existingIndex = acc.findIndex(item => item.id === current.id);
          if (existingIndex >= 0) {
            // If duplicate ID found, use the one with more descriptive name (longer name usually)
            if (current.name.length > acc[existingIndex].name.length) {
              acc[existingIndex] = current;
            }
            this.log.debug(`⚠️  Duplicate input ID "${current.id}" found - keeping "${acc[existingIndex].name}"`);
          } else {
            acc.push(current);
          }
          return acc;
        }, []);

        this.inputSourcesMap = uniqueInputSources.map((source: any) => ({
          id: source.id,        // SmartThings ID (e.g., "HDMI1")
          name: source.name,    // Current custom name from TV (e.g., "PlayStation 5")
        }));

        this.log.info(`📺 Loaded ${this.inputSourcesMap.length} fresh custom input sources for ${this.name}:`);
        this.inputSourcesMap.forEach((source, index) => {
          this.log.info(`   ${index + 1}. "${source.name}" (${source.id})`);
        });

        // Initialize the hash for future change detection
        const sortedSources = uniqueInputSources.sort((a, b) => a.id.localeCompare(b.id));
        this.lastKnownInputSourcesHash = JSON.stringify(sortedSources);

        return;
      } else {
        this.log.debug(`No supportedInputSourcesMap found in status for ${this.name}`);
      }
    } catch (error) {
      this.log.warn(`⚠️  Could not fetch fresh input sources for ${this.name}:`, error);
    }

    // Fallback to common input sources if API fetch fails
    this.inputSourcesMap = [
      { id: 'dtv', name: 'Live TV' },
      { id: 'HDMI1', name: 'HDMI 1' },
      { id: 'HDMI2', name: 'HDMI 2' },
      { id: 'HDMI3', name: 'HDMI 3' },
      { id: 'HDMI4', name: 'HDMI 4' },
    ];
    this.log.warn(`⚠️  Using fallback input sources for ${this.name} - fresh data not available`);

    // Initialize hash for fallback sources too
    const sortedSources = [...this.inputSourcesMap].sort((a, b) => a.id.localeCompare(b.id));
    this.lastKnownInputSourcesHash = JSON.stringify(sortedSources);
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

    // Frame TV: use local WebSocket for power off (3.5s long-press KEY_POWER)
    if (command === 'off' && this.samsungWebSocket && this.enableFullPowerOff) {
      this.log.info(`Frame TV: Sending 3.5s long-press KEY_POWER for full power off on ${this.name}`);
      try {
        await this.samsungWebSocket.holdKey('KEY_POWER', 3500);
        this.log.info(`Frame TV: Full power off successful for ${this.name}`);
        this.multiServiceAccessory.forceNextStatusRefresh();
        return;
      } catch (error) {
        this.log.warn(`Frame TV: WebSocket power off failed for ${this.name}: ${error} — falling back to SmartThings API`);
        // Fall through to standard SmartThings API path below
      }
    }

    // Standard path: use SmartThings API
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

      this.log.debug(`Attempting to set input source to ${targetInput.name} (${targetInput.id}) for ${this.name}`);

      // According to official SmartThings spec, try multiple approaches:
      // 1. Samsung-specific samsungvd.mediaInputSource with setInputSource command
      // 2. Standard mediaInputSource with setInputSource command (fallback)
      let success = false;

      // According to reference implementation: determine if this is an app or input source
      const inputService = this.inputServices[inputIndex];
      if (!inputService) {
        this.log.error(`Input service not found at index ${inputIndex} for ${this.name} (services: ${this.inputServices.length}, map: ${this.inputSourcesMap.length})`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      const inputId = inputService.name ?? targetInput.id; // This contains the SmartThings ID

      this.log.debug(`Setting input source: "${targetInput.name}" using ID "${inputId}" for ${this.name}`);

      if (this.appIds.has(inputId)) {
        // App launch via custom.launchapp
        this.log.info(`Launching app "${targetInput.name}" (${inputId}) on ${this.name}`);
        success = await this.multiServiceAccessory.sendCommand('custom.launchapp', 'launchApp', [inputId]);
      } else {
        // Physical input source — use Samsung-specific mediaInputSource
        this.log.debug(`Using Samsung-specific input source command: samsungvd.mediaInputSource.setInputSource("${inputId}")`);
        success = await this.multiServiceAccessory.sendCommand('samsungvd.mediaInputSource', 'setInputSource', [inputId]);

        // Fallback to standard mediaInputSource capability if Samsung-specific fails
        if (!success) {
          this.log.debug(`Fallback: Using standard input source command: mediaInputSource.setInputSource("${inputId}")`);
          success = await this.multiServiceAccessory.sendCommand('mediaInputSource', 'setInputSource', [inputId]);
        }
      }

      if (success) {
        this.currentInputSource = Number(value);
        this.log.info(`✅ Input source set successfully to ${targetInput.name} (${targetInput.id}) for ${this.name}`);
        setTimeout(() => {
          this.multiServiceAccessory.forceNextStatusRefresh();
        }, 1000);
      } else {
        this.log.error(`❌ Failed to set input source to ${targetInput.name} for ${this.name} - both Samsung and standard commands failed`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } else {
      this.log.error(`Invalid input identifier ${value} for ${this.name} (available: 1-${this.inputSourcesMap.length})`);
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
        if (this.isCapabilitySupported('mediaPlayback')) {
          capability = 'mediaPlayback';
          command = 'rewind';
        }
        break;
      case this.platform.Characteristic.RemoteKey.FAST_FORWARD:
        if (this.isCapabilitySupported('mediaPlayback')) {
          capability = 'mediaPlayback';
          command = 'fastForward';
        }
        break;
      case this.platform.Characteristic.RemoteKey.NEXT_TRACK:
        // According to official tvChannel spec, try channelUp
        if (this.isCapabilitySupported('tvChannel')) {
          capability = 'tvChannel';
          command = 'channelUp';
        }
        break;
      case this.platform.Characteristic.RemoteKey.PREVIOUS_TRACK:
        // According to official tvChannel spec, try channelDown
        if (this.isCapabilitySupported('tvChannel')) {
          capability = 'tvChannel';
          command = 'channelDown';
        }
        break;
      case this.platform.Characteristic.RemoteKey.PLAY_PAUSE:
        // According to official mediaPlayback spec, try play/pause
        if (this.isCapabilitySupported('mediaPlayback')) {
          capability = 'mediaPlayback';
          command = 'play'; // Start with play, could be enhanced to check current playback status
          this.log.debug(`Play/Pause key pressed - sending play command for ${this.name}`);
        }
        break;
      case this.platform.Characteristic.RemoteKey.ARROW_UP:
      case this.platform.Characteristic.RemoteKey.ARROW_DOWN:
      case this.platform.Characteristic.RemoteKey.ARROW_LEFT:
      case this.platform.Characteristic.RemoteKey.ARROW_RIGHT:
      case this.platform.Characteristic.RemoteKey.SELECT:
      case this.platform.Characteristic.RemoteKey.BACK:
      case this.platform.Characteristic.RemoteKey.EXIT:
        // These would require Samsung's custom remote control capabilities (not in standard SmartThings spec)
        this.log.debug(`Navigation/control key ${value} - requires Samsung remote control capability (not implemented)`);
        return;
      case this.platform.Characteristic.RemoteKey.INFORMATION:
        // Could potentially map to info button (not in standard SmartThings spec)
        this.log.debug(`Information key pressed for ${this.name} - not in standard capabilities`);
        return;
      default:
        this.log.warn(`Unsupported remote key: ${value} for ${this.name}`);
        return;
    }

    if (command && capability) {
      try {
        this.log.debug(`Sending remote key command: ${capability}.${command} for ${this.name}`);
        const success = await this.multiServiceAccessory.sendCommand(capability, command);
        if (success) {
          this.log.info(`✅ Remote key command ${capability}.${command} successful for ${this.name}`);
          setTimeout(() => {
            this.multiServiceAccessory.forceNextStatusRefresh();
          }, 500);
        } else {
          this.log.error(`❌ Remote key command ${capability}.${command} failed for ${this.name}`);
        }
      } catch (error) {
        this.log.error(`Error sending remote key command ${capability}.${command} for ${this.name}:`, error);
      }
    } else {
      this.log.debug(`Remote key ${value} - no suitable capability found for ${this.name}`);
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

    // According to official SmartThings audioMute capability spec:
    // - setMute command takes "muted" or "unmuted" string argument
    // - mute/unmute commands take no arguments
    // Try the more explicit setMute command first, fallback to simple commands
    const muteState = value ? 'muted' : 'unmuted';
    this.log.debug(`Sending mute command: audioMute.setMute("${muteState}") for ${this.name}`);

    let success = await this.multiServiceAccessory.sendCommand('audioMute', 'setMute', [muteState]);

    // Fallback to simple mute/unmute commands if setMute fails
    if (!success) {
      const fallbackCommand = value ? 'mute' : 'unmute';
      this.log.debug(`Fallback: Sending audioMute.${fallbackCommand} for ${this.name}`);
      success = await this.multiServiceAccessory.sendCommand('audioMute', fallbackCommand);
    }

    if (success) {
      this.isMuted = Boolean(value);
      this.log.info(`✅ Mute command sent successfully to ${this.name}: ${muteState}`);
      // Force a status refresh after a delay to verify the mute change
      setTimeout(() => {
        this.multiServiceAccessory.forceNextStatusRefresh();
      }, 1000);
    } else {
      this.log.error(`❌ Both setMute and ${value ? 'mute' : 'unmute'} commands failed for ${this.name}`);
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

    // For Samsung TVs, we may need to unmute first if currently muted
    // Check if TV is muted and unmute it before setting volume
    try {
      const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
      const muteState = (component?.status?.audioMute as any)?.mute?.value;

      if (muteState === 'muted' && volumeLevel > 0) {
        this.log.debug(`TV is muted, unmuting before setting volume for ${this.name}`);
        await this.multiServiceAccessory.sendCommand('audioMute', 'unmute');
        // Small delay to ensure unmute command processes
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      this.log.debug(`Could not check mute state before volume change: ${error}`);
    }

    // Samsung TVs sometimes require the volume to be sent as an integer within specific range
    // Ensure volume is bounded between 0-100 and sent as integer
    const boundedVolume = Math.max(0, Math.min(100, Math.round(volumeLevel)));

    this.log.debug(`Sending volume command: audioVolume.setVolume with value [${boundedVolume}] for ${this.name}`);
    const success = await this.multiServiceAccessory.sendCommand('audioVolume', 'setVolume', [boundedVolume]);

    if (success) {
      this.currentVolume = boundedVolume;
      this.log.info(`✅ Volume command sent successfully to ${this.name}: ${boundedVolume}% - Please check if TV volume actually changed`);

      // Samsung TVs sometimes don't report volume changes correctly via API
      // But the commands still work. Force status refresh but don't rely solely on API feedback
      setTimeout(() => {
        this.multiServiceAccessory.forceNextStatusRefresh();
        this.log.debug(`Status refresh completed for ${this.name} - note: Samsung TVs may not report volume changes accurately`);
      }, 1000);
    } else {
      this.log.error(`❌ Volume command failed for ${this.name} - SmartThings API rejected the command`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async setVolumeSelector(value: CharacteristicValue): Promise<void> {
    this.log.debug(`Volume selector for ${this.name}: ${value}`);

    if (!this.multiServiceAccessory.isOnline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const command = value === this.platform.Characteristic.VolumeSelector.INCREMENT ? 'volumeUp' : 'volumeDown';
    this.log.debug(`Sending volume selector command: audioVolume.${command} for ${this.name}`);

    // For Samsung TVs, volumeUp/volumeDown might work better than setVolume
    // These commands don't require specific volume levels and work incrementally
    const success = await this.multiServiceAccessory.sendCommand('audioVolume', command);

    if (success) {
      this.log.debug(`Volume ${command} successful for ${this.name}`);
      // Force a status refresh after a delay to verify the volume change
      setTimeout(() => {
        this.multiServiceAccessory.forceNextStatusRefresh();
      }, 1000);
    } else {
      this.log.error(`Volume ${command} failed for ${this.name}`);
    }
  }



  // Event Processing
  public processEvent(event: ShortEvent): void {
    this.log.debug(`Processing event for TV ${this.name}: ${event.capability} = ${event.value}`);

    switch (event.capability) {
      case 'switch': {
        const isActive = event.value === 'on';
        this.televisionService.updateCharacteristic(
          this.platform.Characteristic.Active,
          isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE,
        );
        break;
      }

      case 'audioMute':
        this.isMuted = event.value === 'muted';
        this.televisionSpeakerService.updateCharacteristic(
          this.platform.Characteristic.Mute,
          this.isMuted,
        );
        // Update speaker active state based on mute status
        this.televisionSpeakerService.updateCharacteristic(
          this.platform.Characteristic.Active,
          !this.isMuted ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE,
        );
        break;

      case 'audioVolume':
        if (typeof event.value === 'number') {
          this.currentVolume = event.value;
          if (this.televisionSpeakerService.testCharacteristic(this.platform.Characteristic.Volume)) {
            this.televisionSpeakerService.updateCharacteristic(
              this.platform.Characteristic.Volume,
              this.currentVolume,
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
              this.currentInputSource,
            );
          }
        }
        break;

      case 'custom.launchapp':
        if (event.attribute === 'launchApp' && typeof event.value === 'string') {
          const appIndex = this.inputSourcesMap.findIndex(input => input.id === event.value);
          if (appIndex >= 0) {
            this.currentInputSource = appIndex + 1;
            this.televisionService.updateCharacteristic(
              this.platform.Characteristic.ActiveIdentifier,
              this.currentInputSource,
            );
            this.log.debug(`App launch event: updated ActiveIdentifier to "${this.inputSourcesMap[appIndex].name}"`);
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
      component.capabilities?.some(cap => cap.id === 'samsungvd.deviceCategory'),
    );

    const hasMediaInput = device.components?.some(component =>
      component.capabilities?.some(cap => cap.id === 'samsungvd.mediaInputSource'),
    );

    const hasAudioCapabilities = device.components?.some(component =>
      component.capabilities?.some(cap => cap.id === 'audioVolume' || cap.id === 'audioMute'),
    );

    const hasTvChannel = device.components?.some(component =>
      component.capabilities?.some(cap => cap.id === 'tvChannel'),
    );

    // A device is considered a TV if it has multiple TV-specific capabilities
    const tvIndicatorCount = [hasDeviceCategory, hasMediaInput, hasAudioCapabilities, hasTvChannel].filter(Boolean).length;

    return tvIndicatorCount >= 2; // Require at least 2 TV-specific capability groups
  }

  /**
   * Monitor input source changes and update HomeKit services dynamically
   * This method is called from the global status polling in MultiServiceAccessory
   */
  public updateFromGlobalStatus(): void {
    try {
      // One-time check: detect if this TV supports Art Mode (Frame TV)
      if (!this.artSupportChecked) {
        this.artSupportChecked = true;
        this.checkArtModeSupport();
      }
      // Check if input sources have changed
      this.checkAndUpdateInputSources().catch(err => {
        this.log.debug(`Error in checkAndUpdateInputSources for ${this.name}: ${err}`);
      });
    } catch (error) {
      this.log.debug(`Error monitoring input sources for ${this.name}:`, error);
    }
  }

  /**
   * Check if this TV reports artSupported: true in its device status.
   * Logs a helpful message if it's a Frame TV that hasn't been configured in frameTvDevices.
   */
  private checkArtModeSupport(): void {
    try {
      const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
      const features = component?.status?.['samsungvd.supportsFeatures'] as any;
      const artSupported = features?.artSupported?.value;

      if (artSupported === true) {
        if (this.samsungWebSocket) {
          this.log.info(`Frame TV confirmed: "${this.name}" reports artSupported=true and is configured for local WebSocket control.`);
        } else {
          this.log.info(
            `Frame TV detected: "${this.name}" reports artSupported=true. ` +
            'To enable full power off and Art Mode control, add this device to the "frameTvDevices" config with its local IP address.',
          );
        }
      }
    } catch {
      // Silent — this is a best-effort detection
    }
  }

  /**
   * Check if input sources have changed and update them if necessary
   */
  private async checkAndUpdateInputSources(): Promise<void> {
    try {
      // Only check if we have the mediaInputSource capability
      if (!this.isCapabilitySupported('samsungvd.mediaInputSource')) {
        return;
      }

      const component = this.multiServiceAccessory.components.find(c => c.componentId === this.componentId);
      const inputSourceData = component?.status?.['samsungvd.mediaInputSource'] as any;

      if (inputSourceData?.supportedInputSourcesMap?.value) {
        const supportedInputSources = inputSourceData.supportedInputSourcesMap.value as { id: string; name: string }[];

        // Create a hash of the current input sources to detect changes
        const currentInputSourcesHash = JSON.stringify(supportedInputSources.sort((a, b) => a.id.localeCompare(b.id)));

        // Check if input sources have changed
        if (this.lastKnownInputSourcesHash !== '' && this.lastKnownInputSourcesHash !== currentInputSourcesHash) {
          this.log.info(`📺 Input source changes detected for ${this.name} - updating HomeKit services`);

          // Parse the new input sources
          const uniqueInputSources = supportedInputSources.reduce((acc: { id: string; name: string }[], current) => {
            const existingIndex = acc.findIndex(item => item.id === current.id);
            if (existingIndex >= 0) {
              if (current.name.length > acc[existingIndex].name.length) {
                acc[existingIndex] = current;
              }
              this.log.debug(`⚠️  Duplicate input ID "${current.id}" found - keeping "${acc[existingIndex].name}"`);
            } else {
              acc.push(current);
            }
            return acc;
          }, []);

          // Update the input sources map (exclude app entries from old list to avoid false "obsolete" detection)
          const oldPhysicalInputSources = this.inputSourcesMap.filter(s => !this.appIds.has(s.id));
          this.inputSourcesMap = uniqueInputSources.map((source: any) => ({
            id: source.id,
            name: source.name,
          }));

          // Log the changes (physical inputs only)
          this.logInputSourceChanges(oldPhysicalInputSources, this.inputSourcesMap);

          // Update existing input source services with new names
          await this.updateExistingInputSources();

          // Handle new input sources (add them)
          await this.addNewInputSources(oldPhysicalInputSources);

          // Handle removed input sources (remove them)
          await this.removeObsoleteInputSources(oldPhysicalInputSources);

          // Re-append app input sources (they're config-based, not from SmartThings)
          this.reappendAppInputSources();

          // Update HomeKit about the changes
          this.platform.api.updatePlatformAccessories([this.accessory]);

          this.log.info(`📺 Input source update completed for ${this.name}`);
        }

        // Update the hash for future comparisons
        this.lastKnownInputSourcesHash = currentInputSourcesHash;
      }
    } catch (error) {
      this.log.error(`Error checking input source changes for ${this.name}:`, error);
    }
  }

  /**
   * Log the changes between old and new input sources
   */
  private logInputSourceChanges(oldSources: Array<{id: string; name: string}>, newSources: Array<{id: string; name: string}>): void {
    // Check for name changes
    oldSources.forEach(oldSource => {
      const newSource = newSources.find(ns => ns.id === oldSource.id);
      if (newSource && newSource.name !== oldSource.name) {
        this.log.info(`🔄 Input source name changed: "${oldSource.name}" -> "${newSource.name}" (${oldSource.id})`);
      }
    });

    // Check for new sources
    const newSourceIds = newSources.map(ns => ns.id);
    const oldSourceIds = oldSources.map(os => os.id);
    const addedSources = newSources.filter(ns => !oldSourceIds.includes(ns.id));
    addedSources.forEach(source => {
      this.log.info(`➕ New input source detected: "${source.name}" (${source.id})`);
    });

    // Check for removed sources
    const removedSources = oldSources.filter(os => !newSourceIds.includes(os.id));
    removedSources.forEach(source => {
      this.log.info(`➖ Input source removed: "${source.name}" (${source.id})`);
    });
  }

  /**
   * Update existing input source services with new names
   */
  private async updateExistingInputSources(): Promise<void> {
    this.inputServices.forEach((inputService) => {
      const inputId = inputService.name; // Contains the SmartThings ID
      const newInputSource = this.inputSourcesMap.find(source => source.id === inputId);

      if (newInputSource) {
        // Update the configured name if it has changed
        const currentConfiguredName = inputService.getCharacteristic(this.platform.Characteristic.ConfiguredName).value;
        if (currentConfiguredName !== newInputSource.name) {
          inputService.setCharacteristic(this.platform.Characteristic.ConfiguredName, newInputSource.name);
          this.log.info(`🔄 Updated input source name: "${currentConfiguredName}" -> "${newInputSource.name}" (${inputId})`);
        }
      }
    });
  }

  /**
   * Add new input sources that weren't previously registered
   */
  private async addNewInputSources(oldSources: Array<{id: string; name: string}>): Promise<void> {
    const oldSourceIds = oldSources.map(os => os.id);
    const newSources = this.inputSourcesMap.filter(ns => !oldSourceIds.includes(ns.id));

    newSources.forEach(newSource => {
      this.registerInputSource(
        newSource.id,
        newSource.name,
        this.getInputSourceType(newSource.id),
      );
      this.log.info(`➕ Added new input source: "${newSource.name}" (${newSource.id}) -> HomeKit ID ${this.inputServices.length}`);
    });
  }

  /**
   * Remove input sources that are no longer available
   */
  private async removeObsoleteInputSources(oldSources: Array<{id: string; name: string}>): Promise<void> {
    const newSourceIds = this.inputSourcesMap.map(ns => ns.id);
    const removedSources = oldSources.filter(os => !newSourceIds.includes(os.id));

    // Remove services for obsolete input sources
    removedSources.forEach(removedSource => {
      const serviceToRemove = this.inputServices.find(service => service.name === removedSource.id);
      if (serviceToRemove) {
        try {
          // Remove the service from the accessory
          this.accessory.removeService(serviceToRemove);

          // Remove from our tracking arrays
          const serviceIndex = this.inputServices.indexOf(serviceToRemove);
          if (serviceIndex > -1) {
            this.inputServices.splice(serviceIndex, 1);
          }

          this.log.info(`➖ Removed obsolete input source: "${removedSource.name}" (${removedSource.id})`);
        } catch (error) {
          this.log.error(`Error removing input source service "${removedSource.name}":`, error);
        }
      }
    });

    // Reindex remaining input sources to maintain sequential identifiers
    this.reindexInputSources();
  }

  /**
   * Reindex input source identifiers after removal to maintain sequential numbering
   */
  private reindexInputSources(): void {
    this.inputServices.forEach((inputService, index) => {
      const newIdentifier = index + 1;
      inputService.setCharacteristic(this.platform.Characteristic.Identifier, newIdentifier);
      const configuredName = inputService.getCharacteristic(this.platform.Characteristic.ConfiguredName).value;
      this.log.debug(`🔢 Reindexed input source "${configuredName}" to identifier ${newIdentifier}`);
    });
  }

  /**
   * Remove stale app InputSource services and re-register them at the end of the list.
   * Called after physical input sources are rebuilt to maintain apps at the end.
   */
  private reappendAppInputSources(): void {
    // Remove existing app input services
    for (const appId of this.appIds) {
      const serviceToRemove = this.inputServices.find(service => service.name === appId);
      if (serviceToRemove) {
        try {
          this.accessory.removeService(serviceToRemove);
          const serviceIndex = this.inputServices.indexOf(serviceToRemove);
          if (serviceIndex > -1) {
            this.inputServices.splice(serviceIndex, 1);
          }
        } catch (error) {
          this.log.error(`Error removing app input source "${appId}":`, error);
        }
      }
      // Also remove from inputSourcesMap
      const mapIndex = this.inputSourcesMap.findIndex(s => s.id === appId);
      if (mapIndex > -1) {
        this.inputSourcesMap.splice(mapIndex, 1);
      }
    }

    // Clear and re-register
    this.appIds.clear();
    this.registerAppInputSources();

    // Reindex all input sources after re-appending
    this.reindexInputSources();
  }

  // Static method to get TV-related capabilities for the capability map
  public static getTvCapabilities(): string[] {
    return [
      'switch', // Power control
      'samsungvd.deviceCategory',
      'samsungvd.mediaInputSource',
      'custom.launchapp',
      'audioVolume',
      'audioMute',
      'tvChannel',
      'mediaPlayback',
      'custom.picturemode',
      'custom.soundmode',
    ];
  }
}
