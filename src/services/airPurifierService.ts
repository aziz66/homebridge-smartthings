import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Command } from './smartThingsCommand';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { BaseService } from './baseService';

enum AirPurifierFanMode {
  Auto = 'auto',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Sleep = 'sleep',
}

enum SwitchState {
  On = 'on',
  Off = 'off',
}

export class AirPurifierService extends BaseService {

  private airPurifierService: Service;
  private airQualitySensorService?: Service;
  private humiditySensorService?: Service;
  private manualModeTimer?: ReturnType<typeof setTimeout>;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding AirPurifierService to ${this.name}`);

    this.airPurifierService = this.setupAirPurifier(platform, multiServiceAccessory);

    if (this.isCapabilitySupported('airQualitySensor') || this.isCapabilitySupported('dustSensor') || this.isCapabilitySupported('odorSensor')) {
      this.airQualitySensorService = this.setupAirQualitySensor(platform, multiServiceAccessory);
    }

    if (this.isCapabilitySupported('relativeHumidityMeasurement')) {
      this.humiditySensorService = this.setupHumiditySensor(platform, multiServiceAccessory);
    }
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

    if (this.isCapabilitySupported('custom.filterState')) {
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

  private setupHumiditySensor(platform: IKHomeBridgeHomebridgePlatform, multiServiceAccessory: MultiServiceAccessory): Service {
    this.log.debug(`Expose Humidity Sensor for ${this.name}`);

    this.setServiceType(platform.Service.HumiditySensor);

    this.service.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getHumidityLevel.bind(this));

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getHumidityLevel.bind(this), this.service, platform.Characteristic.CurrentRelativeHumidity);

    // Link the humidity sensor to the main air purifier service
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
    this.log.info(`[${this.name}] set active to ${switchState}`);
    await this.sendCommandsOrFail([new Command('switch', switchState)]);
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
    const fanMode = deviceStatus.airConditionerFanMode.fanMode.value;
    // MANUAL = 0, AUTO = 1
    return fanMode === AirPurifierFanMode.Auto ? 1 : 0;
  }

  private async setTargetAirPurifierState(value: CharacteristicValue): Promise<void> {
    if (value === 1) {
      // AUTO: cancel any pending manual mode fallback and send immediately
      if (this.manualModeTimer) {
        clearTimeout(this.manualModeTimer);
        this.manualModeTimer = undefined;
      }
      this.log.info(`[${this.name}] set target air purifier state to auto`);
      await this.sendCommandsOrFail([new Command('airConditionerFanMode', 'setFanMode', [AirPurifierFanMode.Auto])]);
    } else {
      // MANUAL: wait briefly for a RotationSpeed call (HomeKit typically sends both together).
      // If setRotationSpeed fires within 500ms it cancels this timer and sends the actual fan mode.
      // If no RotationSpeed follows, fall back to 'low' so the device exits Auto.
      this.log.info(`[${this.name}] set target air purifier state to manual (waiting for rotation speed)`);
      this.manualModeTimer = setTimeout(async () => {
        this.manualModeTimer = undefined;
        this.log.info(`[${this.name}] no rotation speed received, defaulting to low`);
        await this.sendCommandsOrFail([new Command('airConditionerFanMode', 'setFanMode', [AirPurifierFanMode.Low])]);
      }, 500);
    }
  }

  // --- RotationSpeed ---

  private async getRotationSpeed(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const fanMode = deviceStatus.airConditionerFanMode.fanMode.value as AirPurifierFanMode;
    return this.fanModeToLevel(fanMode);
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    // Cancel pending manual-mode fallback — this call supersedes it
    if (this.manualModeTimer) {
      clearTimeout(this.manualModeTimer);
      this.manualModeTimer = undefined;
    }
    const fanMode = this.levelToFanMode(value as number);
    this.log.info(`[${this.name}] set rotation speed to ${fanMode} (from level ${value})`);
    await this.sendCommandsOrFail([new Command('airConditionerFanMode', 'setFanMode', [fanMode])]);
  }

  // --- Filter ---

  private async getFilterLifeLevel(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus['custom.filterState'].filterLifeRemaining.value ?? 100;
  }

  private async getFilterChangeIndication(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const remaining = deviceStatus['custom.filterState'].filterLifeRemaining.value ?? 100;
    // FILTER_OK = 0, CHANGE_FILTER = 1
    return remaining < 10 ? 1 : 0;
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

  // --- Humidity Sensor ---

  private async getHumidityLevel(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus.relativeHumidityMeasurement.humidity.value;
  }

  // --- Helpers ---

  private fanModeToLevel(fanMode: AirPurifierFanMode): number {
    switch (fanMode) {
      case AirPurifierFanMode.Sleep:
        return 15;
      case AirPurifierFanMode.Low:
        return 33;
      case AirPurifierFanMode.Medium:
        return 66;
      case AirPurifierFanMode.High:
        return 100;
      case AirPurifierFanMode.Auto:
      default:
        return 50;
    }
  }

  private levelToFanMode(level: number): AirPurifierFanMode {
    if (level <= 0) {
      return AirPurifierFanMode.Auto;
    }
    if (level <= 20) {
      return AirPurifierFanMode.Sleep;
    }
    if (level <= 45) {
      return AirPurifierFanMode.Low;
    }
    if (level <= 80) {
      return AirPurifierFanMode.Medium;
    }
    return AirPurifierFanMode.High;
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
        this.airPurifierService.updateCharacteristic(this.platform.Characteristic.TargetAirPurifierState,
          event.value === AirPurifierFanMode.Auto ? 1 : 0);
        this.airPurifierService.updateCharacteristic(this.platform.Characteristic.RotationSpeed,
          this.fanModeToLevel(event.value as AirPurifierFanMode));
        break;

      case 'custom.filterState':
        if (this.isCapabilitySupported('custom.filterState')) {
          const remaining = event.value ?? 100;
          this.airPurifierService.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, remaining);
          this.airPurifierService.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication,
            remaining < 10 ? 1 : 0);
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

      case 'relativeHumidityMeasurement':
        this.humiditySensorService?.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, event.value);
        break;

      default:
        this.log.info(`[${this.name}] Ignore event updating ${event.capability} capability to ${event.value}`);
        break;
    }
  }
}
