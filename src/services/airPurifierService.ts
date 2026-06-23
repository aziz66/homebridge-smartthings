import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Command } from './smartThingsCommand';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { BaseService } from './baseService';

enum SwitchState {
  On = 'on',
  Off = 'off',
}

export class AirPurifierService extends BaseService {

  private airPurifierService: Service;
  private airQualitySensorService?: Service;

  private static readonly DEFAULT_FAN_MODES = ['auto', 'low', 'medium', 'high'];

  // Fan modes the device accepts (from airConditionerFanMode.supportedAcFanModes), or
  // the legacy default list when a driver omits/empties that attribute.
  // Cached because fanMode webhook events arrive without the supported-modes list.
  // Samsung purifiers vary: e.g. ['auto','low','medium','high'] or ['smart','max','medium','windfree','sleep','pet'].
  private supportedFanModes: string[] = AirPurifierService.DEFAULT_FAN_MODES;
  private hasDeviceFanModes = false;

  // Lower rank = slower. Unknown modes sort last (rank 99) in device-reported order.
  // Aliases may share a rank, but distinct labels with different speeds do not.
  private static readonly FAN_MODE_RANK: Record<string, number> = {
    sleep: 1,
    silent: 2,
    quiet: 3,
    windfree: 4,
    low: 5,
    medium: 6, mid: 6,
    pet: 7,
    high: 8,
    max: 9,
    turbo: 10,
  };

  // Debounce: HomeKit sends setTargetAirPurifierState and setRotationSpeed near-simultaneously.
  // We track them separately and resolve priority when the timer fires:
  //   Auto > RotationSpeed > Manual default (slowest supported mode)
  private pendingTargetState?: number; // 0 = manual, 1 = auto
  private pendingRotationMode?: string; // a supported fan mode, from setRotationSpeed
  private fanModeTimer?: ReturnType<typeof setTimeout>;
  private static readonly FAN_MODE_DEBOUNCE_MS = 500;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding AirPurifierService to ${this.name}`);

    this.airPurifierService = this.setupAirPurifier(platform, multiServiceAccessory);

    if (
      this.isCapabilitySupported('airQualitySensor') ||
      this.isCapabilitySupported('dustSensor') ||
      this.isCapabilitySupported('odorSensor')
    ) {
      this.airQualitySensorService = this.setupAirQualitySensor(platform, multiServiceAccessory);
    }

    // relativeHumidityMeasurement and temperatureMeasurement are intentionally left to the
    // base-map HumidityService / TemperatureService. Many purifiers declare them but never
    // report a value; the generic SensorService removes such a dead tile on its own
    // (per-device, value-based) and keeps it for models that do report — no config flag needed.

    // Warm the supported-fan-mode cache from the initial status if we already have it, so the
    // first fan read/command after startup can prefer device-reported modes over fallback.
    this.updateFanModeCache(this.deviceStatus?.status);
  }

  private isCapabilitySupported(capability: string): boolean {
    return this.capabilities.find(c => c === capability) !== undefined;
  }

  private setupAirPurifier(platform: IKHomeBridgeHomebridgePlatform, multiServiceAccessory: MultiServiceAccessory): Service {
    this.log.debug(`Expose Air Purifier for ${this.name}`);

    this.setServiceType(platform.Service.AirPurifier);

    this.service.getCharacteristic(platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service.getCharacteristic(platform.Characteristic.CurrentAirPurifierState)
      .onGet(this.getCurrentAirPurifierState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TargetAirPurifierState)
      .onGet(this.getTargetAirPurifierState.bind(this))
      .onSet(this.setTargetAirPurifierState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.RotationSpeed)
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    if (this.isCapabilitySupported('custom.filterState') || this.isCapabilitySupported('custom.hepaFilter')) {
      this.service.getCharacteristic(platform.Characteristic.FilterLifeLevel)
        .onGet(this.getFilterLifeLevel.bind(this));

      this.service.getCharacteristic(platform.Characteristic.FilterChangeIndication)
        .onGet(this.getFilterChangeIndication.bind(this));
    }

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getActive.bind(this), this.service, platform.Characteristic.Active);

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getRotationSpeed.bind(this), this.service, platform.Characteristic.RotationSpeed);

    return this.service;
  }

  private setupAirQualitySensor(platform: IKHomeBridgeHomebridgePlatform, multiServiceAccessory: MultiServiceAccessory): Service {
    this.log.debug(`Expose Air Quality Sensor for ${this.name}`);

    this.setServiceType(platform.Service.AirQualitySensor);

    if (this.isCapabilitySupported('airQualitySensor')) {
      this.service.getCharacteristic(platform.Characteristic.AirQuality)
        .onGet(this.getAirQuality.bind(this));

      multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
        this.getAirQuality.bind(this), this.service, platform.Characteristic.AirQuality);
    }

    if (this.isCapabilitySupported('dustSensor')) {
      this.service.getCharacteristic(platform.Characteristic.PM2_5Density)
        .onGet(this.getPM25Density.bind(this));

      this.service.getCharacteristic(platform.Characteristic.PM10Density)
        .onGet(this.getPM10Density.bind(this));
    }

    if (this.isCapabilitySupported('odorSensor')) {
      this.service.getCharacteristic(platform.Characteristic.VOCDensity)
        .onGet(this.getVOCDensity.bind(this));
    }

    // Link the air quality sensor to the main air purifier service
    this.airPurifierService.addLinkedService(this.service);

    return this.service;
  }

  // --- Active (switch) ---

  private async getActive(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus.switch.switch.value === SwitchState.On ? 1 : 0;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const switchState = value ? SwitchState.On : SwitchState.Off;

    // Skip redundant "switch on" if device is already on (cached status).
    // HomeKit sends setActive(1) alongside mode changes even when already on,
    // causing a double-beep on Samsung air purifiers.
    if (switchState === SwitchState.On
      && this.deviceStatus?.status?.switch?.switch?.value === SwitchState.On) {
      this.log.info(`[${this.name}] skipping redundant switch on (already on)`);
      return;
    }

    this.log.info(`[${this.name}] set active to ${switchState}`);
    await this.sendCommandsOrFail([new Command(this.componentId, 'switch', switchState)]);
  }

  // --- CurrentAirPurifierState ---

  private async getCurrentAirPurifierState(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const isOn = deviceStatus.switch.switch.value === SwitchState.On;
    // INACTIVE = 0, IDLE = 1, PURIFYING_AIR = 2
    return isOn ? 2 : 0;
  }

  // --- TargetAirPurifierState ---

  private async getTargetAirPurifierState(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    this.updateFanModeCache(deviceStatus);
    const fanMode = deviceStatus.airConditionerFanMode.fanMode.value as string;
    // MANUAL = 0, AUTO = 1
    return this.isAutoMode(fanMode) ? 1 : 0;
  }

  private async setTargetAirPurifierState(value: CharacteristicValue): Promise<void> {
    this.log.info(`[${this.name}] set target air purifier state to ${value === 1 ? 'auto' : 'manual'}`);
    this.pendingTargetState = value as number;
    this.resetFanModeTimer();
  }

  // --- RotationSpeed ---

  private async getRotationSpeed(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    this.updateFanModeCache(deviceStatus);
    const fanMode = deviceStatus.airConditionerFanMode.fanMode.value as string;
    return this.fanModeToLevel(fanMode);
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    // Ensure we know the device's real fan modes before translating the slider,
    // otherwise the first set after startup falls back to the legacy default list.
    if (!this.hasDeviceFanModes) {
      this.updateFanModeCache(await this.getDeviceStatus());
    }
    const fanMode = this.levelToFanMode(value as number);
    if (fanMode === undefined) {
      this.log.warn(`[${this.name}] no supported fan mode for level ${value}; ignoring`);
      return;
    }
    this.log.info(`[${this.name}] set rotation speed to ${fanMode} (from level ${value})`);
    this.pendingRotationMode = fanMode;
    this.resetFanModeTimer();
  }

  /**
   * Reset the debounce timer. When it fires, resolve priority:
   *   Auto (target=1) > RotationSpeed > Manual default (slowest supported mode)
   * This ensures only one setFanMode command is sent regardless of
   * how many characteristics HomeKit updates or in what order.
   * Falls back to the legacy default list if the driver does not report supported modes.
   */
  private resetFanModeTimer(): void {
    if (this.fanModeTimer) {
      clearTimeout(this.fanModeTimer);
    }
    this.fanModeTimer = setTimeout(async () => {
      this.fanModeTimer = undefined;
      // Bare Auto/Manual sets don't warm the cache, so make sure we know the real modes first.
      if (!this.hasDeviceFanModes) {
        try {
          this.updateFanModeCache(await this.getDeviceStatus());
        } catch (error) {
          this.log.debug(`[${this.name}] could not load supported fan modes: ${error}`);
        }
      }
      let mode: string | undefined;
      if (this.pendingTargetState === 1) {
        // Auto always wins — ignore any slider value sent alongside
        mode = this.getAutoMode();
      } else if (this.pendingRotationMode !== undefined) {
        // Rotation speed was set — use it (whether or not Manual was also requested)
        mode = this.pendingRotationMode;
      } else {
        // Manual was requested but no rotation speed followed — default to slowest manual mode
        mode = this.manualModes()[0];
      }
      this.pendingTargetState = undefined;
      this.pendingRotationMode = undefined;
      if (mode === undefined) {
        this.log.warn(`[${this.name}] no supported fan mode to send; ignoring`);
        return;
      }
      this.log.info(`[${this.name}] sending debounced fan mode: ${mode}`);
      try {
        await this.sendCommandsOrFail([new Command(this.componentId, 'airConditionerFanMode', 'setFanMode', [mode])]);
      } catch (error) {
        // This runs detached from HomeKit's set handler (fire-and-forget timer), so a rejected
        // command would surface as an unhandledRejection. Log and swallow, like other command paths.
        this.log.warn(`[${this.name}] failed to send fan mode ${mode}: ${error}`);
      }
    }, AirPurifierService.FAN_MODE_DEBOUNCE_MS);
  }

  // --- Filter ---

  private async getFilterLifeLevel(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return this.filterLifeLevelFromStatus(deviceStatus);
  }

  private async getFilterChangeIndication(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return this.filterChangeIndicationFromStatus(deviceStatus);
  }

  // --- Air Quality Sensor ---

  private async getAirQuality(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();

    // Prefer PM2.5-based air quality when dustSensor is available, as SmartThings
    // airQualitySensor.airQuality.value is unreliable (often returns 1 regardless of actual conditions)
    if (this.isCapabilitySupported('dustSensor')) {
      const pm25 = deviceStatus.dustSensor?.fineDustLevel?.value;
      if (pm25 !== undefined && pm25 !== null) {
        return this.pm25ToAirQuality(pm25);
      }
    }

    // Fallback to SmartThings air quality value (1-5 scale)
    const aqValue = deviceStatus.airQualitySensor.airQuality.value;
    return this.stAirQualityToHomeKit(aqValue);
  }

  private async getPM25Density(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus.dustSensor.fineDustLevel.value ?? 0;
  }

  private async getPM10Density(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus.dustSensor.dustLevel.value ?? 0;
  }

  private async getVOCDensity(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus.odorSensor.odorLevel.value ?? 0;
  }

  // --- Fan mode helpers (driven by the device's own supportedAcFanModes) ---

  // Refresh the cached list of supported fan modes from a status payload.
  // If a driver omits or empties supportedAcFanModes, preserve fan control by falling back
  // to the legacy mode set rather than turning the HomeKit controls into no-ops.
  private updateFanModeCache(deviceStatus): void {
    const modes = deviceStatus?.airConditionerFanMode?.supportedAcFanModes?.value;
    const resolved = this.resolveFanModes(modes);
    this.supportedFanModes = resolved.modes;
    this.hasDeviceFanModes = resolved.fromDevice;
  }

  private resolveFanModes(modes): { modes: string[]; fromDevice: boolean } {
    if (Array.isArray(modes)) {
      const resolved = modes.filter(mode => typeof mode === 'string' && mode.length > 0) as string[];
      if (resolved.length > 0) {
        return { modes: resolved, fromDevice: true };
      }
    }
    return { modes: [...AirPurifierService.DEFAULT_FAN_MODES], fromDevice: false };
  }

  // The mode that maps to HomeKit's TargetAirPurifierState AUTO. Prefer 'auto', then 'smart'.
  private getAutoMode(): string | undefined {
    if (this.supportedFanModes.includes('auto')) {
      return 'auto';
    }
    if (this.supportedFanModes.includes('smart')) {
      return 'smart';
    }
    return undefined;
  }

  // A mode is "auto" only if it is the resolved auto mode, so a device exposing BOTH
  // 'auto' and 'smart' treats 'smart' as a normal (manual) speed rather than as auto.
  private isAutoMode(mode: string): boolean {
    return mode !== undefined && mode === this.getAutoMode();
  }

  // Manual (speed) modes only, slowest -> fastest, excluding the resolved auto mode.
  private manualModes(): string[] {
    const auto = this.getAutoMode();
    return this.supportedFanModes
      .filter(m => m !== auto)
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const ra = AirPurifierService.FAN_MODE_RANK[a.m.toLowerCase()] ?? 99;
        const rb = AirPurifierService.FAN_MODE_RANK[b.m.toLowerCase()] ?? 99;
        return ra !== rb ? ra - rb : a.i - b.i; // ties keep device-reported order
      })
      .map(x => x.m);
  }

  // Current fan mode -> HomeKit RotationSpeed (0-100). Auto reports 0 (slider neutral).
  private fanModeToLevel(fanMode: string): number {
    if (this.isAutoMode(fanMode)) {
      return 0;
    }
    const modes = this.manualModes();
    const idx = modes.indexOf(fanMode);
    if (idx < 0 || modes.length === 0) {
      return 0;
    }
    return Math.round(((idx + 1) / modes.length) * 100);
  }

  // HomeKit RotationSpeed (0-100) -> a manual mode the device supports. undefined if none.
  private levelToFanMode(level: number): string | undefined {
    const modes = this.manualModes();
    if (modes.length === 0) {
      return undefined;
    }
    if (level <= 0) {
      return modes[0];
    }
    const idx = Math.min(modes.length - 1, Math.max(0, Math.ceil((level / 100) * modes.length) - 1));
    return modes[idx];
  }

  private filterLifeLevelFromStatus(deviceStatus): number {
    if (this.isCapabilitySupported('custom.filterState')) {
      return this.clampPercent(deviceStatus['custom.filterState']?.filterLifeRemaining?.value, 100);
    }
    // custom.hepaFilter reports usage as a percentage consumed; life remaining = 100 - usage.
    const usage = this.finiteNumber(deviceStatus['custom.hepaFilter']?.hepaFilterUsage?.value);
    return usage === undefined ? 100 : this.clampPercent(100 - usage, 100);
  }

  private filterChangeIndicationFromStatus(deviceStatus): number {
    // FILTER_OK = 0, CHANGE_FILTER = 1
    if (this.isCapabilitySupported('custom.filterState')) {
      const remaining = this.clampPercent(deviceStatus['custom.filterState']?.filterLifeRemaining?.value, 100);
      return remaining < 10 ? 1 : 0;
    }
    const status = deviceStatus['custom.hepaFilter']?.hepaFilterStatus?.value;
    const usage = this.finiteNumber(deviceStatus['custom.hepaFilter']?.hepaFilterUsage?.value);
    const needsChange = (status !== null && status !== undefined && status !== 'normal')
      || (usage !== undefined && usage >= 90);
    return needsChange ? 1 : 0;
  }

  private updateFilterCharacteristics(deviceStatus): void {
    this.airPurifierService.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel,
      this.filterLifeLevelFromStatus(deviceStatus));
    this.airPurifierService.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
      this.filterChangeIndicationFromStatus(deviceStatus));
  }

  // Build an ephemeral status object with this single event's attribute overlaid on the last
  // known status, WITHOUT mutating the shared cache (this.deviceStatus.status is the live object
  // shared with the accessory and replaced wholesale on each poll). Returns a shallow copy so the
  // filter characteristics can be computed from one consistent view.
  private statusWithEventApplied(event: ShortEvent) {
    const status = this.deviceStatus?.status;
    if (status === undefined) {
      return undefined;
    }
    const capabilityStatus = (typeof status[event.capability] === 'object' && status[event.capability] !== null)
      ? status[event.capability]
      : {};
    return {
      ...status,
      [event.capability]: {
        ...capabilityStatus,
        [event.attribute]: { ...(capabilityStatus[event.attribute] ?? {}), value: event.value },
      },
    };
  }

  private finiteNumber(value): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private clampPercent(value, fallback: number): number {
    const numberValue = this.finiteNumber(value);
    if (numberValue === undefined) {
      return fallback;
    }
    return Math.max(0, Math.min(100, numberValue));
  }

  // PM2.5 (µg/m³) to HomeKit AirQuality using WHO/EPA-based thresholds
  private pm25ToAirQuality(pm25: number): number {
    // UNKNOWN=0, EXCELLENT=1, GOOD=2, FAIR=3, INFERIOR=4, POOR=5
    if (pm25 <= 15) {
      return 1; // Excellent (WHO guideline: 15 µg/m³ 24h mean)
    }
    if (pm25 <= 35) {
      return 2; // Good
    }
    if (pm25 <= 55) {
      return 3; // Fair
    }
    if (pm25 <= 75) {
      return 4; // Inferior
    }
    return 5; // Poor
  }

  // SmartThings airQualitySensor value (1-5 scale) to HomeKit AirQuality
  private stAirQualityToHomeKit(value: number): number {
    if (value <= 1) {
      return 1;
    }
    if (value <= 2) {
      return 2;
    }
    if (value <= 3) {
      return 3;
    }
    if (value <= 4) {
      return 4;
    }
    return 5;
  }

  private async sendCommandsOrFail(commands: Command[]) {
    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(this.name + ' is offline');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    if (!await this.multiServiceAccessory.sendCommands(commands)) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async getDeviceStatus(): Promise<any> {
    this.multiServiceAccessory.forceNextStatusRefresh();
    if (!await this.getStatus()) {
      if (this.deviceStatus?.status) {
        this.log.warn(`[${this.name}] Using cached status due to communication failure`);
        return this.deviceStatus.status;
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.deviceStatus.status;
  }

  public processEvent(event: ShortEvent): void {
    this.log.info(`[${this.name}] Event updating ${event.capability} capability to ${event.value}`);

    switch (event.capability) {
      case 'switch':
        this.airPurifierService.updateCharacteristic(this.platform.Characteristic.Active,
          event.value === SwitchState.On ? 1 : 0);
        this.airPurifierService.updateCharacteristic(this.platform.Characteristic.CurrentAirPurifierState,
          event.value === SwitchState.On ? 2 : 0);
        break;

      case 'airConditionerFanMode':
        // The same capability emits both 'fanMode' and 'supportedAcFanModes' events.
        if (event.attribute === 'supportedAcFanModes') {
          const resolved = this.resolveFanModes(event.value);
          this.supportedFanModes = resolved.modes;
          this.hasDeviceFanModes = resolved.fromDevice;
          break;
        }
        // attribute 'fanMode' (or unspecified, for back-compat).
        this.airPurifierService.updateCharacteristic(this.platform.Characteristic.TargetAirPurifierState,
          this.isAutoMode(event.value as string) ? 1 : 0);
        this.airPurifierService.updateCharacteristic(this.platform.Characteristic.RotationSpeed,
          this.fanModeToLevel(event.value as string));
        break;

      case 'custom.filterState':
        if (this.isCapabilitySupported('custom.filterState')) {
          const remaining = this.clampPercent(event.value, 100);
          this.airPurifierService.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, remaining);
          this.airPurifierService.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
            remaining < 10 ? 1 : 0);
        }
        break;

      case 'custom.hepaFilter':
        if (this.isCapabilitySupported('custom.hepaFilter')) {
          // Compute both characteristics from one status view with this event overlaid, so a usage
          // event can't clobber a non-normal status (and vice versa) and a malformed event value
          // can't push NaN. statusWithEventApplied does not mutate the shared cache.
          const status = this.statusWithEventApplied(event);
          if (status !== undefined) {
            this.updateFilterCharacteristics(status);
          }
        }
        break;

      case 'airQualitySensor':
        // Skip unreliable airQualitySensor events when dustSensor is available,
        // as PM2.5-based air quality (updated via dustSensor events) is more accurate
        if (!this.isCapabilitySupported('dustSensor')) {
          this.airQualitySensorService?.updateCharacteristic(this.platform.Characteristic.AirQuality,
            this.stAirQualityToHomeKit(event.value));
        }
        break;

      case 'dustSensor':
        if (event.attribute === 'fineDustLevel') {
          this.airQualitySensorService?.updateCharacteristic(this.platform.Characteristic.PM2_5Density, event.value);
          // Also update AirQuality based on PM2.5 since it's more reliable
          this.airQualitySensorService?.updateCharacteristic(this.platform.Characteristic.AirQuality,
            this.pm25ToAirQuality(event.value));
        } else if (event.attribute === 'dustLevel') {
          this.airQualitySensorService?.updateCharacteristic(this.platform.Characteristic.PM10Density, event.value);
        }
        break;

      case 'odorSensor':
        this.airQualitySensorService?.updateCharacteristic(this.platform.Characteristic.VOCDensity, event.value);
        break;

      default:
        this.log.info(`[${this.name}] Ignore event updating ${event.capability} capability to ${event.value}`);
        break;
    }
  }
}
