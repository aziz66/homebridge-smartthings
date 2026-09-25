import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { InternalAxiosRequestConfig, AxiosHeaders } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import axios = require('axios');
//import { BasePlatformAccessory } from './basePlatformAccessory';
import { MultiServiceAccessory } from './multiServiceAccessory';
import { SubscriptionHandler } from './webhook/subscriptionHandler';
import { SmartThingsAuth } from './auth/auth';
import { WebhookServer } from './webhook/webhookServer';
import { SmartThingsSubscriptionManager } from './webhook/smartthingsSubscriptionManager';
import { CrashLoopManager, CrashErrorType, defaultCrashLoopConfig } from './auth/CrashLoopManager';
import { describeError, redactAxiosError } from './auth/sanitizeError';
import { isAuthRejection } from './auth/tokenManager';
import { ArtModeSwitchService } from './services/artModeSwitchService';
import { TelevisionService } from './services/televisionService';
import {
  extractDisabledComponents,
  hasDisabledComponentsCapability,
  hasRefrigeratorOcfDriver,
} from './util/samsungRefrigerator';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class IKHomeBridgeHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  private locationIDsToIgnore: string[] = [];
  private roomsIDsToIgnore: string[] = [];
  public auth: SmartThingsAuth;
  private crashLoopManager: CrashLoopManager;

  // The Authorization header is set per request by the interceptor below from the managed OAuth token.
  public readonly axInstance = axios.default.create({
    baseURL: this.config.BaseURL || 'https://api.smartthings.com/v1/',
    timeout: 15000,
  });

  private authFlowRetries = 0;
  private lastAuthFlowTime = 0;

  private accessoryObjects: MultiServiceAccessory[] = [];
  private artModeServices: ArtModeSwitchService[] = [];
  private subscriptionHandler: SubscriptionHandler | undefined = undefined;

  // UUIDs of TV devices published as external accessories during the current launch.
  // Used by unregisterDevices() to skip TVs whose bridged cache entries were just
  // unregistered as part of the bridged → external migration (issue #31).
  private externalTvUuids: Set<string> = new Set();

  private webhookServer: WebhookServer;

  // Background re-discovery after startup discovery failed on a transient (network) error.
  private rediscoveryTimer: NodeJS.Timeout | null = null;
  private rediscoveryDelayMs = IKHomeBridgeHomebridgePlatform.REDISCOVERY_INITIAL_DELAY_MS;
  private discoveryCompleted = false;
  private shuttingDown = false;
  private static readonly REDISCOVERY_INITIAL_DELAY_MS = 60 * 1000;
  private static readonly REDISCOVERY_MAX_DELAY_MS = 10 * 60 * 1000;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    // Initialize CrashLoopManager first as auth might use it if it fails early.
    // It's a singleton, so getting instance here ensures it's created with platform logger and storage path.
    this.crashLoopManager = CrashLoopManager.getInstance(this.api.user.storagePath(), this.log);

    // Initialize webhook server first
    const webhookServer = new WebhookServer(this, this.log);
    this.webhookServer = webhookServer;

    // Initialize OAuth2 authentication
    this.auth = new SmartThingsAuth(
      this.config.client_id,
      this.config.client_secret,
      this.log,
      this,
      this.api.user.storagePath(),
      webhookServer,
    );

    // Update axios instance with token refresh interceptor
    this.axInstance.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      const token = this.auth.getAccessToken();
      if (token) {
        if (!config.headers) {
          config.headers = new AxiosHeaders();
        }
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    // Add response interceptor to handle 401 errors with dedup refresh lock
    this.axInstance.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        // Rate limited: wait as long as SmartThings asks (capped) and retry once.
        // Not an auth problem, so it never reaches the refresh/auth-flow handling below.
        if (error.response?.status === 429 && originalRequest && !originalRequest._retry429) {
          originalRequest._retry429 = true;
          const waitMs = IKHomeBridgeHomebridgePlatform.retryAfterMs(error.response.headers?.['retry-after']);
          this.log.warn(`SmartThings rate limit hit (429) for ${originalRequest.url}; retrying in ${Math.round(waitMs / 1000)} s`);
          await this.delay(waitMs);
          return this.axInstance(originalRequest);
        }

        // If the error is 401 and we haven't tried to refresh the token yet
        if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
          originalRequest._retry = true;

          if (!this.auth.tokenManager.getRefreshToken()) {
            this.log.error('Cannot refresh token: No refresh token available.');
            this.triggerAuthFlow();
            return Promise.reject(redactAxiosError(error));
          }

          // Shared with the token expiry monitor: never two refreshes of the same refresh token.
          // If the token was already replaced after this request was sent, just retry with it.
          const sentAuthorization = originalRequest.headers?.Authorization;
          const currentToken = this.auth.getAccessToken();
          try {
            if (!currentToken || sentAuthorization === `Bearer ${currentToken}`) {
              await this.auth.tokenManager.refreshAccessToken();
            }
            // Reset auth retry counter on successful refresh
            this.authFlowRetries = 0;
          } catch (refreshError) {
            this.log.error(`Token refresh failed: ${describeError(refreshError)}`);
            if (isAuthRejection(refreshError)) {
              this.triggerAuthFlow();
            }
            return Promise.reject(redactAxiosError(refreshError));
          }

          // Retry with the new token
          const newToken = this.auth.getAccessToken();
          if (newToken) {
            if (!originalRequest.headers) {
              originalRequest.headers = new AxiosHeaders();
            }
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return this.axInstance(originalRequest);
          }
        }

        // Callers (including services) may log the whole error: never let it carry the token.
        return Promise.reject(redactAxiosError(error));
      },
    );

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('shutdown', () => {
      this.log.debug('Shutdown event received — cleaning up resources');
      this.shuttingDown = true;
      if (this.rediscoveryTimer) {
        clearTimeout(this.rediscoveryTimer);
        this.rediscoveryTimer = null;
      }
      for (const artService of this.artModeServices) {
        artService.stopPolling();
      }
      for (const accObj of this.accessoryObjects) {
        if (accObj.samsungWebSocket) {
          accObj.samsungWebSocket.destroy();
        }
      }
    });

    this.api.on('didFinishLaunching', async () => {
      this.log.debug('Executed didFinishLaunching callback');

      // Warn if the dependent energy flags are set without the parent that activates them.
      if (this.config.ExposeEnergyMonitoring !== true
        && this.config.ExposeEnergyAsOutlet === true) {
        this.log.warn('ExposeEnergyAsOutlet has no effect unless ExposeEnergyMonitoring is enabled.');
      }

      try {
        // Check for crash loop BEFORE attempting any auth or API calls
        if (await this.crashLoopManager.isCrashLoopDetected(defaultCrashLoopConfig)) {
          this.log.warn('[CRASH LOOP DETECTED] Several recent startups failed. Continuing startup without clearing tokens.');
          await this.auth.handleCrashLoopRecovery();
          await this.crashLoopManager.resetCrashState();
        }

        // Initialize OAuth2 flow if needed and wait for it to complete
        const authFlowStarted = await this.auth.initialize();

        // Only proceed with device discovery if auth flow wasn't started and we have a valid token
        if (!authFlowStarted && this.auth.getAccessToken()) {
          await this.discoverAndRegister();
        } else if (authFlowStarted) {
          // If auth flow was started, log the waiting message
          this.log.info('Waiting for SmartThings authentication to complete...');
        } else {
          // Handle case where auth flow wasn't started but token is somehow still invalid (shouldn't happen often)
          this.log.error('Authentication failed or token invalid after initialization.');
        }
      } catch (error) {
        this.log.error(`Error during platform initialization in didFinishLaunching: ${describeError(error)}`);
        // Record that an initialization error occurred.
        // If this error is one that leads to a crash and restart, it will be logged by CrashLoopManager.
        await this.crashLoopManager.recordPotentialCrash(CrashErrorType.API_INIT_FAILURE);
        this.log.error('Platform initialization failed. This might lead to a restart.' +
          ' If this persists, a crash loop recovery might be attempted.');
      }
    });
  }

  /**
   * Discover SmartThings devices and register/restore their accessories. On a transient failure
   * (network down, SmartThings 5xx/429) a background re-discovery is scheduled so the plugin
   * recovers without a Homebridge restart.
   */
  private async discoverAndRegister(): Promise<void> {
    // If locations or rooms to ignore are configured, then
    // load request those from Smartthings to build the id lists.
    if (this.config.IgnoreLocations) {
      this.locationIDsToIgnore = [];
      await this.getLocationsToIgnore();
    }

    let devices: Array<object>;
    try {
      devices = await this.withRetry(
        () => this.getOnlineDevices(),
        3,    // maxRetries
        3000, // baseDelayMs (3 seconds)
        'SmartThings device discovery',
      );
    } catch (error) {
      if (this.isNetworkError(error)) {
        this.scheduleRediscovery();
      }
      throw error;
    }

    this.discoveryCompleted = true;
    if (this.config.UnregisterAll) {
      this.unregisterDevices(devices, true);
    }
    await this.discoverDevices(devices);
    this.unregisterDevices(devices);

    // Discovery worked, so earlier failures were transient - forget them.
    await this.crashLoopManager.resetCrashState();

    // Register Art Mode accessories for configured Frame TVs
    this.registerArtModeAccessories();

    // Warn about any frameTvDevices entry that matched no device (name mismatch)
    this.warnUnmatchedFrameTvDevices();

    // Set up real-time event handling if server_url is configured
    if (this.config.server_url && this.config.server_url.trim() !== '') {
      // Always create the event router so webhook-delivered events are handled
      this.subscriptionHandler = new SubscriptionHandler(this, this.accessoryObjects, this.webhookServer);

      // Attempt to set up SmartThings direct subscriptions (best-effort)
      await this.setupSmartThingsSubscriptions(devices, this.webhookServer);
    }
  }

  // Retry discovery in the background with backoff (60 s doubling up to 10 min) until it succeeds.
  private scheduleRediscovery(): void {
    if (this.shuttingDown || this.discoveryCompleted || this.rediscoveryTimer) {
      return;
    }
    const delayMs = this.rediscoveryDelayMs;
    this.rediscoveryDelayMs = Math.min(delayMs * 2, IKHomeBridgeHomebridgePlatform.REDISCOVERY_MAX_DELAY_MS);
    this.log.warn(`SmartThings device discovery will be retried in ${Math.round(delayMs / 1000)} seconds.`);
    this.rediscoveryTimer = setTimeout(async () => {
      this.rediscoveryTimer = null;
      if (this.shuttingDown || this.discoveryCompleted) {
        return;
      }
      try {
        await this.discoverAndRegister();
        this.log.info('SmartThings device discovery succeeded after retrying.');
      } catch (error) {
        // discoverAndRegister() already re-scheduled itself if the failure was transient.
        this.log.error(`Background SmartThings device discovery failed: ${describeError(error)}`);
      }
    }, delayMs);
    this.rediscoveryTimer.unref?.();
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Rate-limited wrapper for startAuthFlow to avoid spamming auth messages on every 401.
   * Allows 3 rapid calls, then backs off to once per 10 minutes.
   */
  private triggerAuthFlow(): void {
    const now = Date.now();
    if (this.authFlowRetries < 3) {
      this.authFlowRetries++;
      this.lastAuthFlowTime = now;
      this.auth.startAuthFlow();
    } else if (now - this.lastAuthFlowTime > 10 * 60 * 1000) {
      // Reset counter for the new 10-minute window
      this.authFlowRetries = 1;
      this.lastAuthFlowTime = now;
      this.auth.startAuthFlow();
    } else {
      this.log.warn('Auth flow retry limit reached. Check logs for re-authentication instructions.');
    }
  }

  getLocationsToIgnore(): Promise<boolean> {
    this.log.info('Loading locations for exclusion');
    return new Promise((resolve) => {
      this.axInstance.get('locations').then(res => {
        res.data.items.forEach(location => {
          if (this.config.IgnoreLocations.find(l => l.toLowerCase() === location.name.toLowerCase())) {
            this.locationIDsToIgnore.push(location.locationId);
          }
        });
        this.log.info(`Found ${this.locationIDsToIgnore.length} locations to ignore`);
        resolve(true);
      }).catch(reason => {
        this.log.error('Could not load locations: ' + reason + '. You must have r:locations permissions set on the token');
        resolve(true);
      });
    });
  }

  async getOnlineDevices(): Promise<Array<object>> {
    this.log.debug('Discovering devices...');

    const devices: Array<object> = [];
    let nextPageUrl: string | null = 'devices';

    try {
      // Fetch all pages of devices (SmartThings API returns max 200 per page by default)
      while (nextPageUrl) {
        this.log.debug(`Fetching devices from: ${nextPageUrl}`);
        const res = await this.axInstance.get(nextPageUrl);

        const pageItems = res.data.items || [];
        this.log.debug(`Fetched ${pageItems.length} devices from current page`);

        for (const device of pageItems) {
          // If an apostrophe is included in the name of the device in SmartThings, it comes over as a Right Single
          // quote which will not match with a single quote in the config.  This replaces it so it will match
          if (!device.label) {
            device.label = 'Missing Name';
          }
          let deviceName = '';
          try {
            // Handle special characters like right single quote (') that SmartThings uses
            deviceName = device.label.toString().replace(/[\u2018\u2019]/g, '\'').replace(/[\u201C\u201D]/g, '"');
          } catch(error) {
            this.log.warn(`Error getting device name for ${device.label}: ${error}`);
            deviceName = device.label;
          }

          // Check if device should be exclusively shown (whitelist takes precedence)
          if (this.config.ShowOnlyDevices && Array.isArray(this.config.ShowOnlyDevices) && this.config.ShowOnlyDevices.length > 0) {
            const shouldShow = this.config.ShowOnlyDevices.find(showName => {
              if (typeof showName !== 'string') {
                this.log.warn(`Invalid ShowOnlyDevices entry: ${showName} (expected string)`);
                return false;
              }
              const normalizedShowName = showName.replace(/[\u2018\u2019]/g, '\'').replace(/[\u201C\u201D]/g, '"').toLowerCase().trim();
              const normalizedDeviceName = deviceName.toLowerCase().trim();
              return normalizedShowName === normalizedDeviceName;
            });

            if (!shouldShow) {
              this.log.debug(`Skipping ${device.label} because it is not in the ShowOnlyDevices list`);
              continue;
            }
          } else {
            // Check if device should be ignored (only if ShowOnlyDevices is not active)
            if (this.config.IgnoreDevices && Array.isArray(this.config.IgnoreDevices)) {
              const ignoreList = this.config.IgnoreDevices.join(', ');
              this.log.debug(`Checking if device "${deviceName}" should be ignored against list: [${ignoreList}]`);

              const shouldIgnore = this.config.IgnoreDevices.find(ignoreName => {
                if (typeof ignoreName !== 'string') {
                  this.log.warn(`Invalid ignore device entry: ${ignoreName} (expected string)`);
                  return false;
                }
                // Normalize both names for comparison - handle special characters
                const normalizedIgnoreName = ignoreName
                  .replace(/[\u2018\u2019]/g, '\'').replace(/[\u201C\u201D]/g, '"').toLowerCase().trim();
                const normalizedDeviceName = deviceName.toLowerCase().trim();

                this.log.debug(`Comparing normalized names: "${normalizedDeviceName}" vs "${normalizedIgnoreName}"`);
                return normalizedIgnoreName === normalizedDeviceName;
              });

              if (shouldIgnore) {
                this.log.info(`Ignoring ${device.label} because it is in the Ignore Devices list`);
                continue;
              }
            } else if (this.config.IgnoreDevices) {
              this.log.warn('IgnoreDevices configuration is not an array. Expected format: ["Device Name 1", "Device Name 2"]');
            }
          }

          if (!this.locationIDsToIgnore.find(locationID => device.locationId === locationID)) {
            this.log.debug('Pushing ' + device.label);
            devices.push(device);
          } else {
            this.log.info(`Ignoring ${device.label} because it is in a location to ignore (${device.locationId})`);
          }
        }

        // Check for next page - SmartThings API uses _links.next for pagination
        if (res.data._links?.next?.href) {
          // The next href may be a full URL or a relative path
          const nextHref = res.data._links.next.href;
          // Extract just the path and query params if it's a full URL
          if (nextHref.startsWith('http')) {
            const url = new URL(nextHref);
            nextPageUrl = url.pathname.replace('/v1/', '') + url.search;
          } else {
            nextPageUrl = nextHref;
          }
          this.log.debug(`Found next page: ${nextPageUrl}`);
        } else {
          nextPageUrl = null;
        }
      }

      this.log.info(`Discovered ${devices.length} devices total from SmartThings`);
      return devices;
    } catch (error) {
      this.log.error('Error getting devices from Smartthings: ' + error);
      // The caller (didFinishLaunching) records the failure once for crash-loop detection.
      throw error;
    }
  }

  unregisterDevices(devices, all = false) {
    const accessoriesToRemove: PlatformAccessory[] = [];

    if (all) {
      this.log.info('Unregistering all devices');
    }

    //
    // Loop through each accessory.  If they are not present in the list
    // of current devices, then unregister them.
    //
    this.accessories.forEach(accessory => {
      if (all) {
        this.log.info('Will unregister ' + accessory.context.device?.label);
        accessoriesToRemove.push(accessory);
        return;
      }
      if (!devices.find(device => {
        return device.deviceId === accessory.UUID;
      })) {
        // Art Mode accessories use a derived UUID (deviceId + '-artmode'). Keep the ones
        // registerArtModeAccessories() will restore; drop orphans whose TV is gone or whose
        // Art Mode switch was turned off.
        const deviceId: string | undefined = accessory.context.device?.deviceId;
        if (deviceId?.endsWith('-artmode') && this.isArtModeAccessoryWanted(deviceId)) {
          return;
        }
        // Don't re-unregister TVs that were just migrated to external accessories
        // in discoverDevices() — their bridged cache entry is already gone.
        if (this.externalTvUuids.has(accessory.UUID)) {
          return;
        }
        this.log.info('Will unregister ' + accessory.context.device?.label);
        accessoriesToRemove.push(accessory);
      }
    });

    this.removeAccessories(accessoriesToRemove);
  }

  // Unregister accessories from Homebridge and drop them from the restored-accessory cache, so
  // later lookups (discoverDevices, registerArtModeAccessories) don't treat them as existing.
  private removeAccessories(accessories: PlatformAccessory[]): void {
    const unique = [...new Set(accessories)];
    if (unique.length === 0) {
      return;
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, unique);
    for (const accessory of unique) {
      const index = this.accessories.indexOf(accessory);
      if (index !== -1) {
        this.accessories.splice(index, 1);
      }
    }
  }

  // True when a discovered Frame TV will (re)register the Art Mode accessory with this derived id.
  private isArtModeAccessoryWanted(artModeDeviceId: string): boolean {
    return this.accessoryObjects.some(accObj =>
      accObj.samsungWebSocket && accObj.frameTvConfig?.enableArtModeSwitch
      && accObj['accessory'].context.device.deviceId + '-artmode' === artModeDeviceId);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices(devices) {
    const externalAccessories: PlatformAccessory[] = [];
    const restoredAccessories: PlatformAccessory[] = [];
    this.externalTvUuids = new Set();

    for (const device of devices) {
      this.log.debug('DEVICE DATA: ' + JSON.stringify(device));

      if (!this.findSupportedCapability(device)) {
        continue;
      }

      const isTv = TelevisionService.isTelevisionDevice(device)
        && this.config.enableTelevisionService !== false;
      // Default to external publishing (proper TV icon + Control Center remote, issue #31).
      // Set publishTVsAsExternal: false in config to keep TVs bridged (avoids the
      // "More options → Nearby Accessories" pairing flow — issue #37).
      const publishExternal = isTv && this.config.publishTVsAsExternal !== false;
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === device.deviceId);

      if (publishExternal) {
        // Opt-in external publishing: gives HomeKit the proper TV tile + Control
        // Center remote because the accessory advertises ci=TELEVISION on its own
        // Bonjour record. Bridged accessories share the bridge's category and
        // therefore always render with the generic icon (issue #31).
        this.externalTvUuids.add(device.deviceId);

        if (existingAccessory) {
          this.log.info(
            `Migrating ${device.label} from bridged to external accessory for proper TV icon. ` +
            'To re-add it: open Apple Home app → + → Add Accessory → More options → ' +
            'select the TV from nearby accessories → enter your bridge PIN ' +
            '(or child-bridge PIN if the plugin runs in a child bridge).',
          );
          this.removeAccessories([existingAccessory]);
        } else {
          this.log.info('Registering new external TV accessory: ' + device.label);
          this.log.info(
            `To use ${device.label} in Apple Home: open Home app → + → Add Accessory → More options → ` +
            'select the TV from nearby accessories → enter your bridge PIN ' +
            '(or child-bridge PIN if the plugin runs in a child bridge).',
          );
        }

        const accessory = new this.api.platformAccessory(device.label, device.deviceId);
        accessory.context.device = device;
        this.accessoryObjects.push(await this.createAccessoryObject(device, accessory));
        externalAccessories.push(accessory);
        continue;
      }

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        // Refresh the cached device record (label, capabilities, components) before building services.
        existingAccessory.context.device = device;
        this.accessoryObjects.push(await this.createAccessoryObject(device, existingAccessory));
        restoredAccessories.push(existingAccessory);
      } else {
        this.log.info('Registering new accessory: ' + device.label);

        const accessory = new this.api.platformAccessory(device.label, device.deviceId);
        accessory.context.device = device;

        this.accessoryObjects.push(await this.createAccessoryObject(device, accessory));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Persist the refreshed context of restored bridged accessories. (Never for external TVs:
    // updatePlatformAccessories() corrupts the bridge cache for them, issue #31.)
    if (restoredAccessories.length > 0) {
      this.api.updatePlatformAccessories(restoredAccessories);
    }

    if (externalAccessories.length > 0) {
      this.log.info(`Publishing ${externalAccessories.length} TV accessor${externalAccessories.length === 1 ? 'y' : 'ies'} as external`);
      this.api.publishExternalAccessories(PLUGIN_NAME, externalAccessories);
    }
  }

  findSupportedCapability(device): boolean {
    // Look at capabilities on main component
    // const component = device.components.find(c => c.id === 'main');

    // if (component) {
    //   return (component.capabilities.find((ca) => MultiServiceAccessory.capabilitySupported(ca.id)));
    // } else {
    //   return (device.components[0].capabilities.find((ca) => MultiServiceAccessory.capabilitySupported(ca.id)));
    // }

    // Look at capabiliiies on all components

    let found = false;
    device.components.forEach(component => {
      if (!found && component.capabilities.find((ca) => MultiServiceAccessory.capabilitySupported(ca.id))) {
        found = true;
      }
    });
    return found;
  }

  async createAccessoryObject(device, accessory): Promise<MultiServiceAccessory> {
    const acc = new MultiServiceAccessory(this, accessory);
    let components = device.components;

    // Samsung Family Hub fridges: prefetch status once so we can prune
    // compartments the user has disabled in the SmartThings app before
    // creating any HomeKit services for them.
    if (this.config.ExposeMultiZoneRefrigerator === true
        && hasRefrigeratorOcfDriver(device)) {

      // main and cooler usually mirror the same temperatureMeasurement reading;
      // strip it from cooler so HomeKit doesn't get a duplicate Refrigerator tile.
      // Clone rather than mutate — `device` is shared with `accessory.context.device`,
      // which Homebridge persists to disk.
      const mainComp = components.find(c => c.id === 'main');
      const coolerComp = components.find(c => c.id === 'cooler');
      if (mainComp && coolerComp && mainComp.capabilities.some(cap => cap.id === 'temperatureMeasurement')) {
        const strippedCooler = {
          ...coolerComp,
          capabilities: coolerComp.capabilities.filter(cap => cap.id !== 'temperatureMeasurement'),
        };
        components = components.map(c => c === coolerComp ? strippedCooler : c);
      }

      if (hasDisabledComponentsCapability(device)) {
        try {
          const res = await this.axInstance.get(`devices/${device.deviceId}/status`);
          const disabled = extractDisabledComponents(res.data?.components?.main);
          if (disabled.length > 0) {
            this.log.info(`Refrigerator ${device.label}: skipping disabled compartments [${disabled.join(', ')}]`);
            components = components.filter(c => c.id === 'main' || !disabled.includes(c.id));
          }
        } catch (error) {
          this.log.warn(
            `Failed to prefetch status for refrigerator ${device.label}: ${error}. ` +
            'Disabled compartments may appear as "No Response".',
          );
        }
      }
    }

    for (const component of components) {
      await acc.addComponent(component.id, component.capabilities.map((c) => c.id));
    }

    return acc;
  }

  /**
   * Warn about any `frameTvDevices` config entry whose `deviceName` matched no
   * discovered device. This is the most common cause of Frame TV local control
   * silently doing nothing — usually a name mismatch (a stray quote, different
   * casing, etc.). Best-effort: logging only, never throws.
   */
  private warnUnmatchedFrameTvDevices(): void {
    const frameTvDevices: Array<{ deviceName?: string }> = this.config.frameTvDevices || [];
    if (!Array.isArray(frameTvDevices) || frameTvDevices.length === 0) {
      return;
    }
    const discoveredNames = this.accessoryObjects.map(a => a.name);
    for (const ftv of frameTvDevices) {
      const wanted = ftv?.deviceName?.toLowerCase().trim();
      if (!wanted) {
        continue;
      }
      const matched = discoveredNames.some(n => n.toLowerCase().trim() === wanted);
      if (!matched) {
        this.log.warn(
          `Frame TV config "${ftv.deviceName}" did not match any device — its local control ` +
          '(full power-off, Art Mode, D-pad, volume) will be inactive. The deviceName must match the ' +
          `device's name exactly (case-insensitive). Discovered devices: ${discoveredNames.join(', ') || '(none)'}`,
        );
      }
    }
  }

  /**
   * Register separate Art Mode switch accessories for configured Frame TVs.
   * Each Art Mode switch is a standalone platform accessory with its own tile in HomeKit.
   */
  private registerArtModeAccessories(): void {
    for (const accObj of this.accessoryObjects) {
      if (!accObj.samsungWebSocket || !accObj.frameTvConfig?.enableArtModeSwitch) {
        continue;
      }

      const deviceId = accObj['accessory'].context.device.deviceId;
      const artModeUuid = this.api.hap.uuid.generate(deviceId + '-artmode');
      const artModeName = `${accObj.name} Art Mode`;

      const existingAccessory = this.accessories.find(a => a.UUID === artModeUuid);

      if (existingAccessory) {
        this.log.info(`Restoring Art Mode accessory from cache: ${artModeName}`);
        this.artModeServices.push(
          new ArtModeSwitchService(this, existingAccessory, accObj.samsungWebSocket, artModeName),
        );
      } else {
        this.log.info(`Registering new Art Mode accessory: ${artModeName}`);
        const artAccessory = new this.api.platformAccessory(artModeName, artModeUuid);
        artAccessory.context.device = {
          deviceId: deviceId + '-artmode',
          label: artModeName,
          manufacturerName: 'Samsung',
        };
        this.artModeServices.push(
          new ArtModeSwitchService(this, artAccessory, accObj.samsungWebSocket, artModeName),
        );
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [artAccessory]);
      }
    }
  }

  // Method to allow MultiServiceAccessory to get the CrashLoopManager instance
  public getCrashLoopManagerInstance(): CrashLoopManager {
    return this.crashLoopManager;
  }

  /**
   * Retry wrapper for API calls with exponential backoff
   * @param operation - Async function to execute
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param baseDelayMs - Base delay in milliseconds (default: 2000)
   * @param operationName - Name for logging purposes
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    baseDelayMs = 2000,
    operationName = 'API call',
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const isNetworkError = this.isNetworkError(error);

        if (attempt < maxRetries && isNetworkError) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // Exponential backoff
          this.log.warn(
            `[Retry ${attempt}/${maxRetries}] ${operationName} failed: ${lastError.message}. ` +
            `Retrying in ${delayMs / 1000} seconds...`,
          );
          await this.delay(delayMs);
        } else if (!isNetworkError) {
          // Non-network errors should not be retried
          throw error;
        }
      }
    }

    this.log.error(`${operationName} failed after ${maxRetries} attempts`);
    throw lastError;
  }

  /**
   * Check if an error is a network-related error that should be retried
   */
  private isNetworkError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const e = error as { response?: { status?: number }; request?: unknown; isAxiosError?: boolean; code?: string; message?: string };
    const status = e.response?.status;
    if (typeof status === 'number') {
      // The server answered: only overload / server-side failures are worth retrying.
      return status >= 500 || status === 429;
    }
    // An axios request that got no response at all (DNS, refused, reset, timeout, offline...).
    if (e.isAxiosError && e.request) {
      return true;
    }
    const networkErrorCodes = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN',
      'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED', 'ERR_NETWORK'];
    if (networkErrorCodes.includes(e.code ?? '')) {
      return true;
    }
    const message = (e.message ?? '').toLowerCase();
    return message.includes('getaddrinfo') ||
           message.includes('timeout') ||
           message.includes('network') ||
           message.includes('socket hang up');
  }

  /**
   * Milliseconds to wait for a 429 Retry-After header (delta-seconds or HTTP date), capped at
   * 30 s; 5 s when the header is missing or unparseable.
   */
  static retryAfterMs(header: unknown, now = Date.now()): number {
    const MAX_MS = 30 * 1000;
    const DEFAULT_MS = 5 * 1000;
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value))) {
      return Math.min(Math.max(Number(value) * 1000, 0), MAX_MS);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(date - now, 0), MAX_MS);
      }
    }
    return DEFAULT_MS;
  }

  /**
   * Utility function for async delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Set up SmartThings direct subscriptions for real-time event delivery.
   * This is best-effort — if it fails, polling continues to work.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async setupSmartThingsSubscriptions(devices: Array<any>, webhookServer: WebhookServer): Promise<void> {
    try {
      // Step 1: Extract locationId from discovered devices
      const locationIds = new Set<string>();
      for (const device of devices) {
        if (device.locationId) {
          locationIds.add(device.locationId);
        }
      }

      if (locationIds.size === 0) {
        this.log.warn('No locationId found in discovered devices. Cannot set up SmartThings subscriptions.');
        return;
      }

      const locationId = [...locationIds][0]; // Use first location
      if (locationIds.size > 1) {
        this.log.info(`Multiple locations found (${locationIds.size}). Using first location: ${locationId}`);
      }

      // Persist locationId
      await this.auth.tokenManager.updateTokens({ location_id: locationId } as any);

      // Step 2: Get installedAppId — try stored value first, then API
      let installedAppId = this.auth.tokenManager.getInstalledAppId();

      if (installedAppId) {
        this.log.info(`Using installedAppId from stored token (no discovery needed): ${installedAppId}`);
      }

      if (!installedAppId) {
        this.log.info('No stored installedAppId — attempting to discover via Installed Apps API...');
        try {
          const response = await this.axInstance.get('installedapps');
          const installedApps = response.data?.items || [];

          // Find an app matching our location
          const matchingApp = installedApps.find((app: any) => app.locationId === locationId)
            || installedApps[0];

          if (matchingApp) {
            installedAppId = matchingApp.installedAppId;
            this.log.info(`Discovered installedAppId: ${installedAppId}`);
            await this.auth.tokenManager.updateTokens({ installed_app_id: installedAppId } as any);
          } else {
            this.log.warn('No installed apps found via API. SmartThings subscriptions require an installed app. ' +
              'Register your app in the SmartThings developer workspace and install it to your location.');
            return;
          }
        } catch (error: any) {
          const status = error?.response?.status;
          if (status === 403) {
            this.log.warn(
              'Cannot access Installed Apps API (403 Forbidden). ' +
              'Your current OAuth token may not have the required scopes. ' +
              'SmartThings subscriptions will not be set up, but polling continues to work. ' +
              'To enable subscriptions, re-authorize with installedapps scopes or ' +
              'provide the installedAppId via a lifecycle event (INSTALL).',
            );
          } else {
            this.log.warn(`Failed to discover installedAppId: ${error}. Subscriptions will not be set up.`);
          }
          return;
        }
      }

      if (!installedAppId) {
        this.log.warn('No installedAppId available. SmartThings subscriptions will not be set up.');
        return;
      }

      // Step 3: Collect unique capabilities that have actual service handlers (processEvent)
      // Only subscribe to capabilities with registered services, not raw device capabilities
      const capabilityCounts = new Map<string, number>();
      for (const accessory of this.accessoryObjects) {
        for (const capability of accessory.getRegisteredCapabilities()) {
          capabilityCounts.set(capability, (capabilityCounts.get(capability) || 0) + 1);
        }
      }

      // Write discovered capabilities to disk for the UI
      await this.writeAvailableCapabilities(capabilityCounts);

      // Determine which capabilities to subscribe to
      let prioritized: string[];
      const selectedCaps: string[] | undefined = this.config.selectedCapabilities;

      if (Array.isArray(selectedCaps) && selectedCaps.length > 0) {
        // User has manually selected capabilities — use those (filtered to valid ones)
        const valid = selectedCaps.filter(cap => {
          if (capabilityCounts.has(cap)) {
            return true;
          }
          this.log.warn(`Selected capability '${cap}' not found in discovered devices — skipping.`);
          return false;
        }).slice(0, 20);
        if (valid.length === 0) {
          this.log.warn('All user-selected capabilities were invalid. Falling back to automatic prioritization.');
          prioritized = SmartThingsSubscriptionManager.prioritizeCapabilities(capabilityCounts, this.log);
        } else {
          this.log.info(`Using ${valid.length} user-selected capabilities for subscriptions: ${valid.join(', ')}`);
          prioritized = valid;
        }
      } else {
        prioritized = SmartThingsSubscriptionManager.prioritizeCapabilities(capabilityCounts, this.log);
      }

      if (prioritized.length === 0) {
        this.log.warn('No capabilities found to subscribe to.');
        return;
      }

      // Step 4: Create subscription manager and initialize
      const subscriptionManager = new SmartThingsSubscriptionManager(
        this,
        installedAppId,
        locationId,
        this.log,
      );

      await subscriptionManager.initialize(prioritized);
      this.log.info('SmartThings real-time subscriptions set up successfully.');
    } catch (error) {
      this.log.warn(`SmartThings subscription setup failed: ${error}. Polling continues to work.`);
    }
  }

  /**
   * Write discovered capabilities and their device counts to disk so the UI can read them.
   * Uses atomic write (temp + rename) to avoid corrupted reads. Best-effort: non-blocking.
   */
  private async writeAvailableCapabilities(capabilityCounts: Map<string, number>): Promise<void> {
    try {
      const capabilities = [...capabilityCounts.entries()]
        .map(([name, deviceCount]) => ({ name, deviceCount }))
        .sort((a, b) => b.deviceCount - a.deviceCount);

      const data = {
        generatedAt: new Date().toISOString(),
        capabilities,
      };

      const filePath = path.join(this.api.user.storagePath(), 'available_capabilities.json');
      const tmpPath = filePath + '.tmp';
      await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2));
      await fs.promises.rename(tmpPath, filePath);
      this.log.info(`Wrote ${capabilities.length} available capabilities to ${filePath}`);
    } catch (error) {
      this.log.error(
        `Failed to write available_capabilities.json: ${error}. ` +
        'The capability selector UI will not work until this is resolved.',
      );
    }
  }

}

