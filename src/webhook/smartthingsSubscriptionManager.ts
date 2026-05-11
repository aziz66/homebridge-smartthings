import { Logger } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';

const MAX_SUBSCRIPTIONS = 20;

export class SmartThingsSubscriptionManager {
  constructor(
    private readonly platform: IKHomeBridgeHomebridgePlatform,
    private readonly installedAppId: string,
    private readonly locationId: string,
    private readonly log: Logger,
  ) {}

  async flushSubscriptions(): Promise<void> {
    const url = `installedapps/${this.installedAppId}/subscriptions`;
    this.log.info('Flushing all existing SmartThings subscriptions...');
    try {
      await this.platform.axInstance.delete(url);
      this.log.info('Successfully flushed existing subscriptions');
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 403) {
        this.log.warn('Cannot flush subscriptions - insufficient permissions (403). ' +
          'The installedapps scope may not be available with current OAuth token.');
      } else {
        this.log.error(`Failed to flush subscriptions: ${error}`);
      }
      throw error;
    }
  }

  async createCapabilitySubscriptions(capabilities: string[]): Promise<void> {
    // Enforce the 20-subscription limit
    const toSubscribe = capabilities.slice(0, MAX_SUBSCRIPTIONS);
    const overflow = capabilities.slice(MAX_SUBSCRIPTIONS);

    if (overflow.length > 0) {
      this.log.warn(
        `Capability budget exceeded: ${capabilities.length} capabilities but only ${MAX_SUBSCRIPTIONS} subscriptions allowed. ` +
        `The following ${overflow.length} capabilities will remain polling-only: ${overflow.join(', ')}`,
      );
    }

    this.log.info(`Creating ${toSubscribe.length} broad CAPABILITY subscriptions...`);

    let successCount = 0;
    let failCount = 0;

    for (const capability of toSubscribe) {
      try {
        await this.createSingleSubscription(capability);
        successCount++;
      } catch (error: any) {
        failCount++;
        const status = error?.response?.status;
        if (status === 403) {
          this.log.error(
            `Cannot create subscriptions - insufficient permissions (403). ` +
            `Ensure the SmartApp has the correct scopes. Aborting remaining subscriptions.`,
          );
          break;
        }
        this.log.warn(`Failed to subscribe to capability '${capability}': ${error}`);
      }
    }

    this.log.info(
      `Subscription setup complete: ${successCount} succeeded, ${failCount} failed` +
      (overflow.length > 0 ? `, ${overflow.length} polling-only (over budget)` : ''),
    );
  }

  private async createSingleSubscription(capability: string): Promise<void> {
    const url = `installedapps/${this.installedAppId}/subscriptions`;
    const subscriptionName = `hb_${capability}`.substring(0, 36); // SmartThings has a 36-char limit on names

    const payload = {
      sourceType: 'CAPABILITY',
      capability: {
        locationId: this.locationId,
        capability: capability,
        attribute: '*',
        value: '*',
        stateChangeOnly: true,
        subscriptionName: subscriptionName,
      },
    };

    this.log.debug(`Creating subscription for capability: ${capability}`);
    await this.platform.axInstance.post(url, payload);
    this.log.debug(`Successfully subscribed to capability: ${capability}`);
  }

  async initialize(capabilities: string[]): Promise<void> {
    await this.flushSubscriptions();
    await this.createCapabilitySubscriptions(capabilities);
  }

  /**
   * Given a list of capabilities with their device counts, prioritize them for subscription.
   * Returns capabilities sorted by device count (most devices first), limited to MAX_SUBSCRIPTIONS.
   */
  static prioritizeCapabilities(
    capabilityCounts: Map<string, number>,
    log: Logger,
  ): string[] {
    const sorted = [...capabilityCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cap]) => cap);

    if (sorted.length > MAX_SUBSCRIPTIONS) {
      log.info(
        `${sorted.length} unique capabilities found across devices, but subscription limit is ${MAX_SUBSCRIPTIONS}. ` +
        `Prioritizing by device count.`,
      );
      const subscribed = sorted.slice(0, MAX_SUBSCRIPTIONS);
      const pollingOnly = sorted.slice(MAX_SUBSCRIPTIONS);
      log.info(`Real-time subscriptions: ${subscribed.join(', ')}`);
      log.info(`Polling-only (over budget): ${pollingOnly.join(', ')}`);
    }

    return sorted;
  }
}
