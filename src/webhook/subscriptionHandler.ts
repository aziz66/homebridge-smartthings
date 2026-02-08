import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { Logger } from 'homebridge';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { WebhookServer } from './webhookServer';

export interface ShortEvent {
  deviceId: string;
  value: any;
  componentId: string;
  capability: string;
  attribute: string;
}

export class SubscriptionHandler {
  private devices: MultiServiceAccessory[] = [];
  private log: Logger;

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    devices: MultiServiceAccessory[],
    private readonly webhookServer: WebhookServer,
  ) {
    this.log = platform.log;
    this.devices = devices;

    // Register event handler with webhook server
    this.webhookServer.addEventHandler(this.handleDeviceEvent.bind(this));
  }

  private handleDeviceEvent(event: ShortEvent): void {
    const device = this.devices.find(device => device.id === event.deviceId);
    if (device) {
      device.processEvent(event);
    }
  }
}
