import { PlatformAccessory, Characteristic, CharacteristicValue, Service, WithUUID, Logger, API } from 'homebridge';
import axios = require('axios');
import { IKHomeBridgeHomebridgePlatform } from './platform';
import { BaseService } from './services/baseService';
// import { BasePlatformAccessory } from './basePlatformAccessory';
import { MotionService } from './services/motionService';
import { Battery } from './services/batteryService';
import { TemperatureService } from './services/temperatureService';
import { HumidityService } from './services/humidityService';
import { LightSensorService } from './services/lightSensorService';
import { ContactSensorService } from './services/contactSensorService';
import { LockService } from './services/lockService';
import { DoorService } from './services/doorService';
import { SwitchService } from './services/switchService';
import { LightService } from './services/lightService';
import { FanSwitchLevelService } from './services/fanSwitchLevelService';
import { OccupancySensorService } from './services/occupancySensorService';
import { LeakDetectorService } from './services/leakDetector';
import { SmokeDetectorService } from './services/smokeDetector';
import { CarbonMonoxideDetectorService } from './services/carbonMonoxideDetector';
import { ValveService } from './services/valveService';
import { ShortEvent } from './webhook/subscriptionHandler';
import { FanSpeedService } from './services/fanSpeedService';
import { WindowCoveringService } from './services/windowCoveringService';
import { ThermostatService } from './services/thermostatService';
import { StatelessProgrammableSwitchService } from './services/statelessProgrammableSwitchService';
import { AirConditionerService } from './services/airConditionerService';
import { ACLightingService } from './services/acLightingService';
import { TelevisionService } from './services/televisionService';
import { VolumeSliderService } from './services/volumeSliderService';
import { Command } from './services/smartThingsCommand';
import { CrashLoopManager, CrashErrorType } from './auth/CrashLoopManager';
// type DeviceStatus = {
//   timestamp: number;
//   //status: Record<string, unknown>;
//   status: any;
// };

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
// export class MultiServiceAccessory extends BasePlatformAccessory {
export class MultiServiceAccessory {
  //  service: Service;
  //capabilities;
  components: {
    componentId: string;
    capabilities: string[];
    status: Record<string, unknown>;
  }[] = [];

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */

  private services: BaseService[] = [];

  // Order of these matters.  Make sure secondary capabilities like 'battery' and 'contactSensor' are at the end.
  private static capabilityMap = {
    'doorControl': DoorService,
    'lock': LockService,
    'switch': SwitchService,
    'windowShadeLevel': WindowCoveringService,
    'windowShade': WindowCoveringService,
    'motionSensor': MotionService,
    'waterSensor': LeakDetectorService,
    'smokeDetector': SmokeDetectorService,
    'carbonMonoxideDetector': CarbonMonoxideDetectorService,
    'presenceSensor': OccupancySensorService,
    'temperatureMeasurement': TemperatureService,
    'relativeHumidityMeasurement': HumidityService,
    'illuminanceMeasurement': LightSensorService,
    'contactSensor': ContactSensorService,
    'button': StatelessProgrammableSwitchService,
    'battery': Battery,
    'valve': ValveService,
    'samsungce.airConditionerLighting': ACLightingService,
  };

  // Maps combinations of supported capabilities to a service
  private static comboCapabilityMap = [
    {
      capabilities: [
        'switch',
        'airConditionerMode',
        'airConditionerFanMode',
        'thermostatCoolingSetpoint',
        'temperatureMeasurement',
      ],
      optionalCapabilities: [
        'fanOscillationMode',
        'relativeHumidityMeasurement',
        'custom.airConditionerOptionalMode',
      ],
      service: AirConditionerService,
    },
    {
      capabilities: ['switch', 'fanSpeed', 'switchLevel'],
      service: FanSwitchLevelService,
    },
    {
      capabilities: ['switch', 'fanSpeed'],
      service: FanSpeedService,
    },
    {
      capabilities: ['switch', 'switchLevel'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'colorControl'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'colorTemperature'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'valve'],
      service: ValveService,
    },
    {
      capabilities: ['temperatureMeasurement',
        'thermostatMode',
        'thermostatHeatingSetpoint',
        'thermostatCoolingSetpoint'],
      service: ThermostatService,
    },
    {
      // There is a heater out there that just supports thermostatMode and thermostatHeatingSetpoint
      capabilities: ['temperatureMeasurement',
        'thermostatHeatingSetpoint'],
      service: ThermostatService,
    },
    {
      capabilities: ['windowShade', 'windowShadeLevel'],
      service: WindowCoveringService,
    },
    {
      capabilities: ['windowShade', 'switchLevel'],
      service: WindowCoveringService,
    },
  ];

  protected accessory: PlatformAccessory;
  protected platform: IKHomeBridgeHomebridgePlatform;
  public readonly name: string;
  protected characteristic: typeof Characteristic;
  protected log: Logger;
  protected baseURL: string;
  protected key: string;
  protected axInstance: axios.AxiosInstance;
  protected commandURL: string;
  protected statusURL: string;
  protected healthURL: string;
  protected api: API;
  protected online = true;
  //protected deviceStatus: DeviceStatus = { timestamp: 0, status: undefined };
  protected deviceStatusTimestamp = 0;
  protected failureCount = 0;
  protected giveUpTime = 0;
  protected commandInProgress = false;
  protected lastCommandCompleted = 0;

  protected statusQueryInProgress = false;
  protected lastStatusResult = true;

  // Add a field for CrashLoopManager
  private crashLoopManager: CrashLoopManager;

  get id() {
    return this.accessory.UUID;
  }

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
  ) {
    this.accessory = accessory;
    this.platform = platform;
    this.name = accessory.context.device.label;
    this.log = platform.log;
    this.baseURL = platform.config.BaseURL;
    this.key = platform.config.AccessToken;
    this.api = platform.api;

    // Get CrashLoopManager instance from platform
    this.crashLoopManager = platform.getCrashLoopManagerInstance();

    this.commandURL = 'devices/' + accessory.context.device.deviceId + '/commands';
    this.statusURL = 'devices/' + accessory.context.device.deviceId + '/status';
    this.healthURL = 'devices/' + accessory.context.device.deviceId + '/health';
    this.characteristic = platform.Characteristic;

    // set accessory information
    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, accessory.context.device.manufacturerName)
      .setCharacteristic(platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(platform.Characteristic.SerialNumber, 'Default-Serial');

    // Use platform's axios instance to benefit from token refresh handling
    this.axInstance = platform.axInstance;

    // Initialize device health check
    this.checkDeviceHealth().catch(error => {
      this.log.error(`Error checking device health for ${this.name}:`, error);
      this.online = false;
    });
  }

  private async checkDeviceHealth(): Promise<void> {
    try {
      const response = await this.axInstance.get(this.healthURL);
      this.online = response.data.state === 'ONLINE';
      this.log.debug(`Device ${this.name} is ${this.online ? 'online' : 'offline'}`);
      // If successfully checked health, and previously we might have been in a loop,
      // this doesn't reset the loop counter directly, but successful init is good.
    } catch (error) {
      this.log.error(`Failed to check device health for ${this.name}:`, error);
      this.online = false;
      // Record this specific failure type for crash loop detection
      // This assumes checkDeviceHealth is critical and its failure might lead to a crash loop
      await this.crashLoopManager.recordPotentialCrash(CrashErrorType.DEVICE_HEALTH_FAILURE);
      throw error; // Re-throw to be caught by the platform initialization or calling function
    }
  }

  private registerServiceIfMatchesCapabilities(
    componentId: string,
    component: any,
    capabilitiesToCover: string[],
    capabilities: string[],
    optionalCapabilities: string[],
    serviceConstructor: any,
  ): string[] {
    // this.log.debug(`Testing ${serviceConstructor.name} for capabilities ${capabilitiesToCover}`);
    // ignore services which cannot cover all required capabilities
    if (!capabilities.every(e => capabilitiesToCover.includes(e))) {
      // this.log.debug(`Ignoring ${serviceConstructor.name}`);
      return capabilitiesToCover;
    }

    const allCapabilities = capabilities.concat(optionalCapabilities.filter(e => capabilitiesToCover.includes(e)));

    this.log.debug(`Creating instance of ${serviceConstructor.name} for capabilities ${allCapabilities}`);
    const serviceInstance = new serviceConstructor(this.platform, this.accessory, componentId, allCapabilities, this, this.name, component);
    this.services.push(serviceInstance);

    this.log.debug(`Registered ${serviceConstructor.name} for capabilities ${allCapabilities}`);
    // remove covered capabilities and return unused
    return capabilitiesToCover.filter(e => !allCapabilities.includes(e));
  }

  public addComponent(componentId: string, capabilities: string[]) {
    const component = {
      componentId,
      capabilities,
      status: {},
    };
    this.components.push(component);

    let capabilitiesToCover = [...capabilities];

    // Check if this device is a TV and TV service is enabled
    const isTelevisionEnabled = this.platform.config.enableTelevisionService !== false; // Default to true
    const removeLegacySwitch = this.platform.config.removeLegacySwitchForTV === true; // Default to false

    if (isTelevisionEnabled && componentId === 'main' && this.isTelevisionDevice()) {
      this.log.debug(`Detected TV device: ${this.name}, setting up Television service`);

      // Register the Television service with all TV-related capabilities
      const tvCapabilities = TelevisionService.getTvCapabilities().filter(cap => capabilities.includes(cap));

      if (tvCapabilities.length > 0) {
        this.log.debug(`Creating Television service for ${this.name} with capabilities: ${tvCapabilities.join(', ')}`);
        const serviceInstance = new TelevisionService(
          this.platform,
          this.accessory,
          componentId,
          tvCapabilities,
          this,
          this.name,
          component,
        );
        this.services.push(serviceInstance);

        // Trigger input source registration if mediaInputSource capability is available
        if (tvCapabilities.includes('samsungvd.mediaInputSource')) {
          this.log.debug(`🔄 Triggering input source registration for ${this.name}`);
          // Use setTimeout to allow constructor to complete first
          setTimeout(async () => {
            try {
              await serviceInstance.registerInputSourceCapability();
            } catch (error) {
              this.log.error(`Failed to register input sources for ${this.name}:`, error);
            }
          }, 100);
        }

                     // Remove TV capabilities from the list to avoid duplicate services
             capabilitiesToCover = capabilitiesToCover.filter(cap => !tvCapabilities.includes(cap));

             // If configured to remove legacy switch, remove the 'switch' capability
             if (removeLegacySwitch && tvCapabilities.includes('switch')) {
               this.log.debug(`Removing legacy switch service for TV: ${this.name}`);
               // 'switch' capability is already removed from capabilitiesToCover above
             } else if (tvCapabilities.includes('switch')) {
               // Keep the switch capability for legacy compatibility
               capabilitiesToCover.push('switch');
               this.log.debug(`Keeping legacy switch service alongside Television service for: ${this.name}`);
             }

             // Add volume slider as lightbulb service to the SAME TV accessory (same tile in HomeKit)
             // CRITICAL: Only create for main TV component with volume capabilities
             const registerVolumeSlider = this.platform.config.registerVolumeSlider === true;
             if (registerVolumeSlider && componentId === 'main' && VolumeSliderService.supportsVolumeSlider(capabilities)) {
               this.log.debug(`Creating volume slider service within TV accessory for main component: ${this.name}`);
               const volumeSliderCapabilities = VolumeSliderService.getVolumeSliderCapabilities().filter(cap => capabilities.includes(cap));

               if (volumeSliderCapabilities.length > 0) {
                 const volumeSliderService = new VolumeSliderService(
                   this.platform,
                   this.accessory,
                   componentId, // 'main' component for TV
                   volumeSliderCapabilities,
                   this,
                   this.name,
                   component,
                 );
                 this.services.push(volumeSliderService);

                 // Remove volume capabilities from other services to avoid conflicts
                 capabilitiesToCover = capabilitiesToCover.filter(cap => !volumeSliderCapabilities.includes(cap));
                 this.log.info(`📱 Volume slider service added to ${this.name} TV tile - volume controls now visible in Home app`);
               }
             }


           }
         }

    // Start with comboServices and remove used capabilities to avoid duplicated sensors.
    // For example, there is no need to expose a temperature sensor in case of a thermostat which already exposes that charateristic.
    MultiServiceAccessory.comboCapabilityMap
      .sort((a, b) => a.capabilities.length > b.capabilities.length ? -1 : 1) // services with larger capability set first
      .forEach(entry => {
        capabilitiesToCover = this.registerServiceIfMatchesCapabilities(
          componentId,
          component,
          capabilitiesToCover,
          entry.capabilities,
          entry.optionalCapabilities || [],
          entry.service,
        );
      });

    Object.keys(MultiServiceAccessory.capabilityMap).forEach((capability) => {
      const service = MultiServiceAccessory.capabilityMap[capability];

      // Skip AC Display Light service if not enabled in config
      if (capability === 'samsungce.airConditionerLighting' && !this.platform.config.ExposeACDisplayLight) {
        this.log.debug(`Skipping AC Display Light service for ${this.name} - not enabled in config`);
        return;
      }

      capabilitiesToCover = this.registerServiceIfMatchesCapabilities(
        componentId,
        component,
        capabilitiesToCover,
        [capability],
        [],
        service,
      );
    });
  }

  public isOnline(): boolean {
    return this.online;
  }

  // Find return if a capability is supported by the multi-service accessory
  public static capabilitySupported(capability: string): boolean {
    if (Object.keys(MultiServiceAccessory.capabilityMap).find(c => c === capability)) {
      return true;
    }

    // Check if it's a TV-related capability
    if (TelevisionService.getTvCapabilities().includes(capability)) {
      return true;
    }

    // Check if it's a volume slider capability
    if (VolumeSliderService.getVolumeSliderCapabilities().includes(capability)) {
      return true;
    }



    return false;
  }

  // Check if this device is a Television
  private isTelevisionDevice(): boolean {
    return TelevisionService.isTelevisionDevice(this.accessory.context.device);
  }

  // public async refreshStatus(): Promise<boolean> {
  //   return super.refreshStatus();
  // }

  // Called by subclasses to refresh the status for the device.  Will only refresh if it has been more than
  // 4 seconds since last refresh
  //
  async refreshStatus(): Promise<boolean> {
    return new Promise((resolve) => {
      this.log.debug(`Refreshing status for ${this.name} - current timestamp is ${this.deviceStatusTimestamp}`);
      if (Date.now() - this.deviceStatusTimestamp > 5000) {
        // If there is already a call to smartthings to update status for this device, don't issue another one until
        // we return from that.
        if (this.statusQueryInProgress) {
          this.log.debug(`Status query already in progress for ${this.name}.  Waiting...`);
          this.waitFor(() => !this.statusQueryInProgress).then(() => resolve(this.lastStatusResult));
          return;
        }
        this.log.debug(`Calling Smartthings to get an update for ${this.name}`);
        this.statusQueryInProgress = true;
        this.failureCount = 0;
        this.waitFor(() => this.commandInProgress === false).then(() => {
          this.lastStatusResult = true;
          this.axInstance.get(this.statusURL).then((res) => {
            const componentsStatus = res.data.components;
            this.components.forEach(component => {
              if (componentsStatus[component.componentId] !== undefined) {
                component.status = componentsStatus[component.componentId];
                this.deviceStatusTimestamp = Date.now();
                this.log.debug(`Updated status for ${this.name}-${component.componentId}: ${JSON.stringify(component.status)}`);
              } else {
                this.log.error(`Failed to get status for ${this.name}-${component.componentId}`);
              }
            });

            // Notify VolumeSliderService about global status update
            this.notifyVolumeSliderOfStatusUpdate();

            // Notify TelevisionService about global status update for input source monitoring
            this.notifyTelevisionServiceOfStatusUpdate();

            this.statusQueryInProgress = false;
            resolve(true);
            // if (res.data.components.main !== undefined) {
            //   this.deviceStatus.status = res.data.components.main;
            //   this.deviceStatus.timestamp = Date.now();
            //   this.log.debug(`Updated status for ${this.name}: ${JSON.stringify(this.deviceStatus.status)}`);
            //   this.statusQueryInProgress = false;
            //   resolve(true);
            // } else {
            //   this.log.debug(`No status returned for ${this.name}`);
            //   this.statusQueryInProgress = false;
            //   resolve(this.lastStatusResult = false);
            // }
          }).catch(async error => {
            this.failureCount++;
            this.log.error(`Failed to request status from ${this.name}: ${error}.  This is failure number ${this.failureCount}`);
            // If consistent polling failures for a device cause broader instability/crashes,
            // we might record it. For now, focusing on init-time crashes.
            // Example: await this.crashLoopManager.recordPotentialCrash(CrashErrorType.UNKNOWN_API_FAILURE);
            if (this.failureCount >= 5) {
              this.log.error(`Exceeded allowed failures for ${this.name}.  Device is offline`);
              this.giveUpTime = Date.now();
              this.online = false;
            }
            this.statusQueryInProgress = false;
            resolve(this.lastStatusResult = false);
          });
        });
      } else {
        resolve(true);
      }
    });
  }

  public forceNextStatusRefresh() {
    this.deviceStatusTimestamp = 0;
  }

  /**
   * Notify VolumeSliderService instances about global status updates
   * This allows volume slider to update its characteristics without separate polling
   */
  private notifyVolumeSliderOfStatusUpdate(): void {
    this.services.forEach(service => {
      if (service instanceof VolumeSliderService) {
        service.updateFromGlobalStatus();
      }
    });
  }

  /**
   * Notify TelevisionService instances about global status updates
   * This allows TV services to monitor input source changes dynamically
   */
  private notifyTelevisionServiceOfStatusUpdate(): void {
    this.services.forEach(service => {
      if (service instanceof TelevisionService) {
        service.updateFromGlobalStatus();
      }
    });
  }


  // public startPollingState(pollSeconds: number, getValue: () => Promise<CharacteristicValue>, service: Service,
  //   chracteristic: WithUUID<new () => Characteristic>, targetStateCharacteristic?: WithUUID<new () => Characteristic>,
  //   getTargetState?: () => Promise<CharacteristicValue>) {
  //   return super.startPollingState(pollSeconds, getValue, service, chracteristic, targetStateCharacteristic, getTargetState);
  // }

  startPollingState(pollSeconds: number, getValue: () => Promise<CharacteristicValue>, service: Service,
    chracteristic: WithUUID<new () => Characteristic>, targetStateCharacteristic?: WithUUID<new () => Characteristic>,
    getTargetState?: () => Promise<CharacteristicValue>): NodeJS.Timer | void {

    if (pollSeconds > 0) {
      return setInterval(() => {
        // If we are in the middle of a commmand call, or it hasn't been at least 10 seconds, we don't want to poll.
        if (this.commandInProgress || Date.now() - this.lastCommandCompleted < 20 * 1000) {
          // Skip polling until command is complete
          this.log.debug(`Command in progress, skipping polling for ${this.name}`);
          return;
        }
        if (this.online) {
          this.log.debug(`${this.name} polling...`);
          // this.commandInProgress = true;
          getValue().then((v) => {
            service.updateCharacteristic(chracteristic, v);
            this.log.debug(`${this.name} value updated.`);
            // Reset failure count on successful poll
            this.failureCount = 0;
          }).catch((error) => {
            // Track polling failures but don't crash
            this.failureCount++;
            this.log.warn(`Poll failure on ${this.name} (attempt ${this.failureCount}): ${error?.message || error}`);

            // If we've had too many consecutive failures, mark device offline
            if (this.failureCount >= 5) {
              this.log.error(`${this.name} marked offline after ${this.failureCount} consecutive poll failures`);
              this.online = false;
              this.giveUpTime = Date.now();
            }
            // Don't update characteristic with error during polling -
            // this prevents crashing and allows recovery on next successful poll
          });
          // Update target if we have to
          if (targetStateCharacteristic && getTargetState) {
            //service.updateCharacteristic(targetStateCharacteristic, getTargetState());
            getTargetState().then(value => service.updateCharacteristic(targetStateCharacteristic, value))
              .catch((error) => {
                this.log.debug(`Failed to update target state for ${this.name}: ${error?.message || error}`);
              });
          }
        } else {
          // If we failed this accessory due to errors. Reset the failure count and online status after 10 minutes.
          if (this.giveUpTime > 0 && (Date.now() - this.giveUpTime > (10 * 60 * 1000))) {
            this.axInstance.get(this.healthURL)
              .then(res => {
                if (res.data.state === 'ONLINE') {
                  this.online = true;
                  this.giveUpTime = 0;
                  this.failureCount = 0;
                }
              });
          }
        }
      }, pollSeconds * 1000 + Math.floor(Math.random() * 1000));  // Add a random delay to avoid collisions
    }
  }

  async sendCommand(capability: string, command: string, args?: unknown[]): Promise<boolean> {
    const cmd = new Command(capability, command, args);
    return this.sendCommands([cmd]);
  }

  async sendCommands(commands: Command[]): Promise<boolean> {
    const commandBody = JSON.stringify({ commands: commands });
    return new Promise((resolve) => {
      this.waitFor(() => !this.commandInProgress).then(() => {
        this.commandInProgress = true;
        this.axInstance.post(this.commandURL, commandBody).then(() => {
          this.log.debug(`${JSON.stringify(commands)} successful for ${this.name}`);
          this.deviceStatusTimestamp = 0; // Force a refresh on next poll after a state change
          this.commandInProgress = false;
          resolve(true);
          // Force a small delay so that status fetch is correct
          // setTimeout(() => {
          //   this.log.debug(`Delay complete for ${this.name}`);
          //   this.commandInProgress = false;
          //   resolve(true);
          // }, 1500);
        }).catch((error) => {
          this.commandInProgress = false;
          this.log.error(`${JSON.stringify(commands)} failed for ${this.name}: ${error}`);
          resolve(false);
        });
      });
    });
  }

  // Wait for the condition to be true.  Will check every 500 ms
  private async waitFor(condition: () => boolean): Promise<void> {
    if (condition()) {
      return;
    }

    this.log.debug(`${this.name} command or request is waiting...`);
    return new Promise(resolve => {
      const interval = setInterval(() => {
        if (condition()) {
          this.log.debug(`${this.name} command or request is proceeding.`);
          clearInterval(interval);
          resolve();
        }
        this.log.debug(`${this.name} still waiting...`);
      }, 250);
    });
  }

  public getRegisteredCapabilities(): string[] {
    const caps = new Set<string>();
    for (const service of this.services) {
      for (const cap of service.capabilities) {
        caps.add(cap);
      }
    }
    return [...caps];
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Received events for ${this.name}`);

    const service = this.services.find(s => s.componentId === event.componentId && s.capabilities.find(c => c === event.capability));

    if (service) {
      this.log.debug(`Event for ${this.name}:${event.componentId} - ${event.value}`);
      service.processEvent(event);
    }

  }

}
