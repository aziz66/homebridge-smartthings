import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { SamsungWebSocket } from '../local/samsungWebSocket';

/**
 * Art Mode Switch Service
 * Exposed as a separate HomeKit Switch accessory to toggle Art Mode on Samsung Frame TVs.
 * Uses local WebSocket connection to the TV's art mode channel.
 */
export class ArtModeSwitchService {
  private readonly platform: IKHomeBridgeHomebridgePlatform;
  private readonly accessory: PlatformAccessory;
  private readonly samsungWs: SamsungWebSocket;
  private readonly name: string;
  private readonly service: Service;
  private artModeOn = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private pollCount = 0;

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
    samsungWs: SamsungWebSocket,
    name: string,
  ) {
    this.platform = platform;
    this.accessory = accessory;
    this.samsungWs = samsungWs;
    this.name = name;

    // Set accessory information
    this.accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(platform.Characteristic.Model, 'Frame TV Art Mode')
      .setCharacteristic(platform.Characteristic.SerialNumber, 'ArtMode');

    // Create the Switch service
    this.service = this.accessory.getService(platform.Service.Switch)
      || this.accessory.addService(platform.Service.Switch, name);

    this.service.setCharacteristic(platform.Characteristic.Name, name);

    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    // Poll art mode status periodically
    this.startPolling();
  }

  private async getOn(): Promise<CharacteristicValue> {
    this.platform.log.debug(`Getting art mode state for ${this.name}`);
    try {
      const status = await this.samsungWs.getArtModeStatus();
      this.artModeOn = status === 'on';
      this.consecutiveFailures = 0;
      this.platform.log.debug(`Art mode state for ${this.name}: ${this.artModeOn}`);
      return this.artModeOn;
    } catch (error) {
      this.platform.log.debug(`Could not get art mode status for ${this.name}, using cached: ${this.artModeOn}`);
      return this.artModeOn;
    }
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const targetState = value as boolean;
    this.platform.log.info(`Frame TV: Setting art mode to ${targetState ? 'on' : 'off'} for ${this.name}`);

    try {
      await this.samsungWs.setArtModeStatus(targetState ? 'on' : 'off');
      this.artModeOn = targetState;
      this.platform.log.info(`Frame TV: Art mode ${targetState ? 'on' : 'off'} successful for ${this.name}`);
    } catch (error) {
      this.platform.log.error(`Frame TV: Failed to set art mode for ${this.name}: ${error}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      this.pollCount++;

      // Backoff when TV seems unreachable: after 3 consecutive failures,
      // only poll every 6th cycle (~3 min). After 6+ failures, every 20th (~10 min).
      if (this.consecutiveFailures >= 6 && this.pollCount % 20 !== 0) {
        return;
      }
      if (this.consecutiveFailures >= 3 && this.pollCount % 6 !== 0) {
        return;
      }

      try {
        const status = await this.samsungWs.getArtModeStatus();
        const newState = status === 'on';
        if (this.consecutiveFailures > 0) {
          this.platform.log.debug(`Art mode polling recovered for ${this.name} after ${this.consecutiveFailures} failures`);
        }
        this.consecutiveFailures = 0;
        if (newState !== this.artModeOn) {
          this.artModeOn = newState;
          this.service.updateCharacteristic(this.platform.Characteristic.On, this.artModeOn);
          this.platform.log.debug(`Art mode state updated for ${this.name}: ${this.artModeOn}`);
        }
      } catch {
        this.consecutiveFailures++;
        if (this.consecutiveFailures === 3) {
          this.platform.log.debug(`Art mode polling for ${this.name}: TV unreachable, reducing poll frequency`);
        }
      }
    }, 30000);
  }

  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
