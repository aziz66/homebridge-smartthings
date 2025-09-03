import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { SamsungTVApps } from './tvApps';
import { ShortEvent } from '../webhook/subscriptionHandler';

/**
 * Application Selector Service
 * Creates a separate switch accessory for launching TV applications (Netflix, YouTube, etc.)
 * This keeps apps separate from physical input sources for better organization.
 */
export class ApplicationSelectorService extends BaseService {
  private currentApp = 0;
  private availableApps: Array<{id: string; name: string}> = [];

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

    // Create the service as a Switch with custom name
    this.service = this.accessory.getService(`${name} Apps`) ||
      this.accessory.addService(this.platform.Service.Switch, `${name} Apps`, 'AppSelector');

    // Set the display name
    this.service.setCharacteristic(this.platform.Characteristic.Name, `${name} Apps`);

    // Load available applications
    this.loadAvailableApps();

    // Setup characteristics
    this.setupCharacteristics();

    this.log.info(`📱 Application selector created for ${this.name} with ${this.availableApps.length} apps`);
  }

  private loadAvailableApps(): void {
    // Use the Samsung TV apps list
    this.availableApps = SamsungTVApps.map(app => ({
      id: app.ids[0], // Use first app ID
      name: app.name,
    }));
  }

  private setupCharacteristics(): void {
    // On/Off controls the current app (toggle between first app and "off")
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getAppActive.bind(this))
      .onSet(this.setAppActive.bind(this));

    // Add a custom characteristic for app selection (if supported by platform)
    // For now, we'll use the switch to cycle through apps
  }

  private async getAppActive(): Promise<CharacteristicValue> {
    // Return true if any app is currently active
    // This is a simplified implementation - in reality you'd check the current input source
    return this.currentApp > 0;
  }

  private async setAppActive(value: CharacteristicValue): Promise<void> {
    if (!this.multiServiceAccessory.isOnline()) {
      this.log.warn(`${this.name} is offline - cannot launch application`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    if (value) {
      // Launch the first/default app (Netflix)
      const defaultApp = this.availableApps[0];
      if (defaultApp) {
        this.log.info(`📱 Launching ${defaultApp.name} on ${this.name}`);
        const success = await this.multiServiceAccessory.sendCommand('custom.launchapp', 'launchApp', [defaultApp.id]);
        
        if (success) {
          this.currentApp = 1;
          this.log.info(`✅ Successfully launched ${defaultApp.name} on ${this.name}`);
        } else {
          this.log.error(`❌ Failed to launch ${defaultApp.name} on ${this.name}`);
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      }
    } else {
      // "Turn off" - could switch back to live TV or previous input
      this.log.info(`📺 Switching back to live TV on ${this.name}`);
      const success = await this.multiServiceAccessory.sendCommand('samsungvd.mediaInputSource', 'setInputSource', ['dtv']);
      
      if (success) {
        this.currentApp = 0;
        this.log.info(`✅ Successfully switched to live TV on ${this.name}`);
      } else {
        this.log.error(`❌ Failed to switch to live TV on ${this.name}`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }

    // Refresh status after a delay
    setTimeout(() => {
      this.multiServiceAccessory.forceNextStatusRefresh();
    }, 1000);
  }

  public processEvent(event: ShortEvent): void {
    // Handle app-related events if needed
    this.log.debug(`Processing app selector event for ${this.name}:`, event);
  }

  // Static methods for capability detection
  public static supportsApplicationSelector(capabilities: string[]): boolean {
    return capabilities.includes('custom.launchapp');
  }

  public static getApplicationSelectorCapabilities(): string[] {
    return ['custom.launchapp'];
  }
}
