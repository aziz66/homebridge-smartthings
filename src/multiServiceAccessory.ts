import { PlatformAccessory, Characteristic, CharacteristicValue, Service, WithUUID, Logger, API } from 'homebridge';
import axios = require('axios');
import { IKHomeBridgeHomebridgePlatform } from './platform';
import { BaseService } from './services/baseService';
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
import { WasherService } from './services/washerService';
import { DryerService } from './services/dryerService';
import { DishwasherService } from './services/dishwasherService';
import { RobotVacuumService } from './services/robotVacuumService';
import { AirPurifierService } from './services/airPurifierService';
import { SecuritySystemService } from './services/securitySystemService';
import { RefrigeratorTemperatureService } from './services/refrigeratorTemperatureService';
import { ZigbangSmartDoorlockService } from './services/zigbangSmartDoorlockService';
import { EnergyService } from './services/energyService';
import { extractDisabledComponents } from './util/samsungRefrigerator';
import { Command } from './services/smartThingsCommand';
import { SamsungWebSocket } from './local/samsungWebSocket';
import { describeError } from './auth/sanitizeError';
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
    [ZigbangSmartDoorlockService.STATE_CAPABILITY_ID]: ZigbangSmartDoorlockService,
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
      capabilities: ['switch', 'airConditionerFanMode'],
      optionalCapabilities: [
        'custom.filterState',
        'custom.hepaFilter',
        'airQualitySensor',
        'dustSensor',
        'veryFineDustSensor',
        'odorSensor',
        // relativeHumidityMeasurement is deliberately NOT consumed here: it falls through to the
        // base-map HumidityService (a SensorService) which shows a value when reported and removes
        // itself when the device only ever returns null — per-device, no config flag, like temperature.
      ],
      service: AirPurifierService,
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
      // Optional so colour / colour-temperature events are subscribed and routed to the
      // bulb whichever pair matched first (LightService detects features from the device).
      optionalCapabilities: ['switchLevel', 'colorControl', 'colorTemperature'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'colorControl'],
      // Optional so colour / colour-temperature events are subscribed and routed to the
      // bulb whichever pair matched first (LightService detects features from the device).
      optionalCapabilities: ['switchLevel', 'colorControl', 'colorTemperature'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'colorTemperature'],
      // Optional so colour / colour-temperature events are subscribed and routed to the
      // bulb whichever pair matched first (LightService detects features from the device).
      optionalCapabilities: ['switchLevel', 'colorControl', 'colorTemperature'],
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
      // Heating-only thermostats (Stelpro, Danfoss, baseboard, in-floor) often expose mode
      // and operating state without a cooling setpoint — keep them when the device has them.
      capabilities: ['temperatureMeasurement',
        'thermostatHeatingSetpoint'],
      optionalCapabilities: ['thermostatMode', 'thermostatOperatingState'],
      service: ThermostatService,
    },
    {
      // Thermostats using a single temperatureSetpoint (e.g. Koolnova HVAC)
      // instead of separate heating/cooling setpoints
      capabilities: ['temperatureMeasurement',
        'thermostatMode',
        'temperatureSetpoint'],
      optionalCapabilities: ['switch'],
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
    {
      capabilities: ['washerOperatingState'],
      optionalCapabilities: ['washerMode', 'remoteControlStatus'],
      service: WasherService,
    },
    {
      capabilities: ['dryerOperatingState'],
      optionalCapabilities: ['dryerMode', 'remoteControlStatus'],
      service: DryerService,
    },
    {
      capabilities: ['dishwasherOperatingState'],
      optionalCapabilities: ['dishwasherMode', 'remoteControlStatus'],
      service: DishwasherService,
    },
    {
      capabilities: ['samsungce.robotCleanerOperatingState', 'switch'],
      optionalCapabilities: ['robotCleanerMovement'],
      service: RobotVacuumService,
    },
    {
      capabilities: ['securitySystem'],
      optionalCapabilities: ['alarm', 'panicAlarm', 'temperatureAlarm'],
      service: SecuritySystemService,
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
  protected api: API;
  protected online = true;
  //protected deviceStatus: DeviceStatus = { timestamp: 0, status: undefined };
  protected deviceStatusTimestamp = 0;
  protected failureCount = 0;
  protected giveUpTime = 0;
  protected commandInProgress = false;
  protected lastCommandCompleted = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;
  private static readonly OFFLINE_RETRY_INTERVAL_MS = 60 * 1000;
  // A device is only marked offline after failures spanning at least this long, so a short
  // SmartThings or network blip doesn't turn working tiles into "No Response".
  private static readonly MIN_FAILURE_SPAN_MS = 60 * 1000;
  private static readonly ON_DEMAND_RETRY_INTERVAL_MS = 10 * 1000;
  private firstFailureAt = 0;

  protected statusQueryInProgress = false;
  protected lastStatusResult = true;
  protected hasInitialStatus = false;

  // Frame TV: optional local WebSocket for full power off and art mode
  public samsungWebSocket: SamsungWebSocket | null = null;
  public frameTvConfig: { enableFullPowerOff: boolean; enableArtModeSwitch: boolean; infoButtonKey: string } | null = null;

  get id() {
    return this.accessory.UUID;
  }

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
  ) {
    this.accessory = accessory;
    this.platform = platform;
    this.name = accessory.context.device.label || accessory.context.device.name || 'Unknown Device';
    this.log = platform.log;
    this.baseURL = platform.config.BaseURL;
    this.key = platform.config.AccessToken;
    this.api = platform.api;

    this.commandURL = 'devices/' + accessory.context.device.deviceId + '/commands';
    this.statusURL = 'devices/' + accessory.context.device.deviceId + '/status';
    this.characteristic = platform.Characteristic;

    // set accessory information
    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, accessory.context.device.manufacturerName || 'SmartThings')
      .setCharacteristic(platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(platform.Characteristic.SerialNumber, 'Default-Serial');

    // Use platform's axios instance to benefit from token refresh handling
    this.axInstance = platform.axInstance;

    // Check if this device is a configured Frame TV
    const frameTvDevices: Array<{ deviceName: string; ip: string; enableFullPowerOff?: boolean; enableArtModeSwitch?: boolean;
      infoButtonKey?: string; token?: string; }>
      = platform.config.frameTvDevices || [];
    const matchedFrameTv = frameTvDevices.find(
      ftv => ftv.deviceName && ftv.deviceName.toLowerCase().trim() === this.name.toLowerCase().trim(),
    );
    if (matchedFrameTv) {
      if (!matchedFrameTv.ip || matchedFrameTv.ip.trim() === '') {
        this.log.warn(`Frame TV config for "${this.name}" is missing IP address — skipping WebSocket setup`);
      } else {
        this.log.info(`Frame TV detected: ${this.name} at ${matchedFrameTv.ip}`);
        this.samsungWebSocket = new SamsungWebSocket(
          matchedFrameTv.ip,
          this.log,
          this.api.user.storagePath(),
          matchedFrameTv.token,
        );
        this.frameTvConfig = {
          enableFullPowerOff: matchedFrameTv.enableFullPowerOff !== false, // default true
          enableArtModeSwitch: matchedFrameTv.enableArtModeSwitch !== false, // default true
          infoButtonKey: (matchedFrameTv.infoButtonKey || 'KEY_INFO').trim() || 'KEY_INFO',
        };
      }
    }
  }

  public mainHasCapability(capabilityId: string): boolean {
    return this.components.find(c => c.componentId === 'main')?.capabilities.includes(capabilityId) ?? false;
  }

  // Runtime safety net for the disabled-compartments prune in platform.ts.
  // Returns true only after main's status has been refreshed at least once.
  public isComponentDisabled(componentId: string): boolean {
    if (componentId === 'main') {
      return false;
    }
    const mainStatus = this.components.find(c => c.componentId === 'main')?.status;
    return extractDisabledComponents(mainStatus).includes(componentId);
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

    // Route temperature sensors on Samsung Family Hub fridges to the OCF-aware
    // subclass so per-compartment readings work (sub-components return null on
    // standard temperatureMeasurement).
    let resolvedConstructor = serviceConstructor;
    if (serviceConstructor === TemperatureService
        && this.platform.config.ExposeMultiZoneRefrigerator === true
        && this.mainHasCapability('samsungce.driverState')) {
      resolvedConstructor = RefrigeratorTemperatureService;
    }

    this.log.debug(`Creating instance of ${resolvedConstructor.name} for capabilities ${allCapabilities}`);
    const serviceInstance = new resolvedConstructor(
      this.platform, this.accessory, componentId, allCapabilities, this, this.name, component);
    this.services.push(serviceInstance);

    this.log.debug(`Registered ${serviceConstructor.name} for capabilities ${allCapabilities}`);
    // remove covered capabilities and return unused
    return capabilitiesToCover.filter(e => !allCapabilities.includes(e));
  }

  public async addComponent(componentId: string, capabilities: string[]) {
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
        // If this is a Frame TV, configure the WebSocket for power off
        if (this.samsungWebSocket && this.frameTvConfig) {
          serviceInstance.setFrameTvWebSocket(
            this.samsungWebSocket, this.frameTvConfig.enableFullPowerOff, this.frameTvConfig.infoButtonKey);
        }

        this.services.push(serviceInstance);

        // Trigger input source registration if mediaInputSource capability is available.
        // Done synchronously so all input services are present on the accessory before
        // it gets registered/published — avoids needing updatePlatformAccessories() later
        // (which corrupts the bridge's cache for externally-published TVs, issue #31).
        if (tvCapabilities.includes('samsungvd.mediaInputSource')) {
          this.log.debug(`🔄 Triggering input source registration for ${this.name}`);
          try {
            await serviceInstance.registerInputSourceCapability();
          } catch (error) {
            this.log.error(`Failed to register input sources for ${this.name}: ${describeError(error)}`);
          }
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
        // Skip Robot Vacuum service if not enabled in config
        if (entry.service === RobotVacuumService && !this.platform.config.ExposeRobotVacuum) {
          this.log.debug(`Skipping Robot Vacuum service for ${this.name} - not enabled in config`);
          return;
        }

        capabilitiesToCover = this.registerServiceIfMatchesCapabilities(
          componentId,
          component,
          capabilitiesToCover,
          entry.capabilities,
          entry.optionalCapabilities || [],
          entry.service,
        );
      });

    // Suppress the legacy Switch tile on laundry accessories when the user
    // opts in. Mirrors the removeLegacySwitchForTV pattern above.
    const removeLaundrySwitch = this.platform.config.removeLegacySwitchForLaundry === true;
    if (removeLaundrySwitch && capabilitiesToCover.includes('switch')) {
      const hasLaundryService = this.services.some(s =>
        s instanceof WasherService || s instanceof DryerService || s instanceof DishwasherService,
      );
      if (hasLaundryService) {
        this.log.debug(`Removing legacy switch service for laundry device: ${this.name}`);
        capabilitiesToCover = capabilitiesToCover.filter(cap => cap !== 'switch');
      }
    }

    Object.keys(MultiServiceAccessory.capabilityMap).forEach((capability) => {
      const service = MultiServiceAccessory.capabilityMap[capability];

      // Skip AC Display Light service if not enabled in config
      if (capability === 'samsungce.airConditionerLighting' && !this.platform.config.ExposeACDisplayLight) {
        this.log.debug(`Skipping AC Display Light service for ${this.name} - not enabled in config`);
        return;
      }

      // Skip Zigbang Smart Doorlock service if not enabled in config
      if (capability === ZigbangSmartDoorlockService.STATE_CAPABILITY_ID && !this.platform.config.ExposeZigbangSmartDoorlock) {
        this.log.debug(`Skipping Zigbang Smart Doorlock service for ${this.name} - not enabled in config`);
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

    // Energy monitoring: opt-in. Scoped to plug/switch/outlet accessories — runs LAST so
    // the on/off host (Switch/Outlet) already exists for the Eve characteristics to attach
    // to, and never synthesizes a tile. TVs and ACs are excluded: they report power too but
    // have no plain on/off host (energy would land on the wrong tile, e.g. an AC mode switch
    // or a TV volume slider). Modeled on the TV/volume-slider special cases rather than the
    // combo map, because energy capabilities are alternatives (a device may report any subset)
    // which the combo map's "ALL required" semantics can't express. Subscriptions + event
    // routing are auto-wired via the service's capabilities[] (getRegisteredCapabilities/processEvent).
    if (EnergyService.isEligible(this.platform, this, componentId, capabilities)) {
      const host = EnergyService.findHost(this.accessory, this.platform);
      const energyCaps = EnergyService.ENERGY_CAPABILITIES.filter(c => capabilitiesToCover.includes(c));
      if (host && energyCaps.length > 0) {
        this.log.debug(`Adding EnergyService to ${this.name} for [${energyCaps.join(', ')}]`);
        this.services.push(
          new EnergyService(this.platform, this.accessory, componentId, energyCaps, this, this.name, component),
        );
      } else if (energyCaps.length > 0) {
        // Explain the skip rather than dropping silently - the common cause is a combo
        // service having consumed `switch` (e.g. switch + switchLevel -> LightService).
        this.log.debug(`Skipping EnergyService for ${this.name}: no Switch/Outlet/Lightbulb tile on main to attach `
          + `[${energyCaps.join(', ')}] to`);
      }
    } else if (componentId === 'main' && this.platform.config.ExposeEnergyMonitoring !== true
      && EnergyService.pruneCachedCharacteristics(this.accessory)) {
      // Feature turned back off: drop Eve characteristics restored from cachedAccessories,
      // which would otherwise sit on the tile frozen at their last value with no handler.
      this.log.debug(`Removed cached energy characteristics from ${this.name} (energy monitoring is off)`);
    }
  }

  // Every caller that finds the device offline (a HomeKit read or a command) also kicks off a
  // recovery probe, throttled more loosely than the background one, so control comes back within
  // seconds of SmartThings answering again instead of waiting for the next background retry.
  // For commands sent outside sendCommands() (e.g. the Frame TV WebSocket power-off): pause
  // polling briefly so a stale cached status isn't pushed back over the new state.
  public pausePollingAfterCommand(): void {
    this.lastCommandCompleted = Date.now();
  }

  public isOnline(): boolean {
    if (!this.online) {
      this.attemptOfflineRecovery(MultiServiceAccessory.ON_DEMAND_RETRY_INTERVAL_MS);
    }
    return this.online;
  }

  // Find return if a capability is supported by the multi-service accessory
  public static capabilitySupported(capability: string): boolean {
    if (Object.keys(MultiServiceAccessory.capabilityMap).find(c => c === capability)) {
      return true;
    }

    // Check combo capability map for capabilities only registered there
    if (MultiServiceAccessory.comboCapabilityMap.some(entry =>
      entry.capabilities.includes(capability))) {
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
  public isTelevisionDevice(): boolean {
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

            this.hasInitialStatus = true;
            this.markOnline();
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
            // Count consecutive failed status refreshes; any successful refresh resets the count.
            if (this.failureCount === 0) {
              this.firstFailureAt = Date.now();
            }
            this.failureCount++;
            this.log.error(`Failed to request status from ${this.name}: ${error}.  This is failure number ${this.failureCount}`);
            if (this.failureCount >= MultiServiceAccessory.MAX_CONSECUTIVE_FAILURES
              && Date.now() - this.firstFailureAt >= MultiServiceAccessory.MIN_FAILURE_SPAN_MS) {
              if (this.online) {
                this.log.error(`Exceeded allowed failures for ${this.name}.  Device is offline`);
              }
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

  // The device answered (status, command or webhook event): clear any offline state.
  protected markOnline(): void {
    if (!this.online) {
      this.log.info(`${this.name} is responding again - marking it online`);
    }
    this.online = true;
    this.failureCount = 0;
    this.firstFailureAt = 0;
    this.giveUpTime = 0;
  }

  /**
   * While offline, periodically try a real status refresh; success brings the device back online
   * (see refreshStatus). Throttled via giveUpTime so an offline device costs one request per
   * OFFLINE_RETRY_INTERVAL_MS. Called from the poll loop and from reads (so it also works with
   * polling disabled). Cloud /health is not used: it is unreliable for Edge drivers.
   */
  public attemptOfflineRecovery(minIntervalMs = MultiServiceAccessory.OFFLINE_RETRY_INTERVAL_MS): void {
    if (this.online || this.statusQueryInProgress) {
      return;
    }
    if (this.giveUpTime > 0 && Date.now() - this.giveUpTime < minIntervalMs) {
      return;
    }
    this.giveUpTime = Date.now();
    this.log.debug(`Trying to reach offline device ${this.name}`);
    this.forceNextStatusRefresh();
    this.refreshStatus().catch((error) => {
      // Must not reject unhandled: Node turns that into an uncaughtException and
      // Homebridge shuts down. Stay offline and retry later.
      this.log.debug(`Offline recovery failed for ${this.name}: ${error?.message || error}`);
    });
  }

  public forceNextStatusRefresh() {
    this.deviceStatusTimestamp = 0;
  }

  public hasCachedStatus(): boolean {
    return this.hasInitialStatus;
  }

  // When the cached status was last refreshed. Lets a service tell whether the snapshot
  // it is reading predates a webhook event it has already applied.
  public statusTimestamp(): number {
    return this.deviceStatusTimestamp;
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
        // If we are in the middle of a command call, or it hasn't been at least 20 seconds, we don't want to poll.
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
          }).catch((error) => {
            // Don't crash and don't update the characteristic with an error. Offline state is
            // driven by consecutive failed status refreshes (refreshStatus), which the getter
            // behind a failed poll already counted - counting here too would double it.
            this.log.warn(`Poll failure on ${this.name}: ${error?.message || error}`);
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
          this.attemptOfflineRecovery();
        }
      }, pollSeconds * 1000 + Math.floor(Math.random() * 1000));  // Add a random delay to avoid collisions
    }
  }

  async sendCommand(componentId: string, capability: string, command: string, args?: unknown[]): Promise<boolean> {
    const cmd = new Command(componentId, capability, command, args);
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
          this.lastCommandCompleted = Date.now(); // Pause polling briefly so the cloud catches up
          this.commandInProgress = false;
          this.markOnline();
          resolve(true);
          // Force a small delay so that status fetch is correct
          // setTimeout(() => {
          //   this.log.debug(`Delay complete for ${this.name}`);
          //   this.commandInProgress = false;
          //   resolve(true);
          // }, 1500);
        }).catch((error) => {
          this.lastCommandCompleted = Date.now();
          this.commandInProgress = false;
          this.log.error(`${JSON.stringify(commands)} failed for ${this.name}: ${error}`);
          resolve(false);
        });
      });
    });
  }

  // Upper bound for waitFor(). Requests time out after 15 s, so this only trips if something
  // is wedged; proceeding beats blocking every later command/refresh for this device forever.
  protected waitForTimeoutMs = 30 * 1000;

  // Wait for the condition to be true (checked every 250 ms), for at most waitForTimeoutMs.
  // Resolves true if the condition was met, false if the wait timed out.
  private async waitFor(condition: () => boolean): Promise<boolean> {
    if (condition()) {
      return true;
    }

    this.log.debug(`${this.name} command or request is waiting...`);
    const deadline = Date.now() + this.waitForTimeoutMs;
    return new Promise(resolve => {
      const interval = setInterval(() => {
        if (condition()) {
          this.log.debug(`${this.name} command or request is proceeding.`);
          clearInterval(interval);
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          this.log.warn(`${this.name}: gave up waiting for a previous command or status request after `
            + `${Math.round(this.waitForTimeoutMs / 1000)} s - proceeding`);
          clearInterval(interval);
          resolve(false);
          return;
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
    this.markOnline(); // SmartThings only sends events for a device it can reach

    const service = this.services.find(s => s.componentId === event.componentId && s.capabilities.find(c => c === event.capability));

    if (service) {
      this.log.debug(`Event for ${this.name}:${event.componentId} - ${event.value}`);
      service.processEvent(event);
    }

  }

}
