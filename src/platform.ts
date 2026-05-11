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

  private headerDict = {
    'Authorization': 'Bearer: ' + this.config.AccessToken,
  };

  public readonly axInstance = axios.default.create({
    baseURL: this.config.BaseURL,
    headers: this.headerDict,
  });

  private refreshTokenPromise: Promise<void> | null = null;
  private authFlowRetries = 0;
  private lastAuthFlowTime = 0;

  private accessoryObjects: MultiServiceAccessory[] = [];
  private artModeServices: ArtModeSwitchService[] = [];
  private subscriptionHandler: SubscriptionHandler | undefined = undefined;

  // UUIDs of TV devices published as external accessories during the current launch.
  // Used by unregisterDevices() to skip TVs whose bridged cache entries were just
  // unregistered as part of the bridged → external migration (issue #31).
  private externalTvUuids: Set<string> = new Set();

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

        // If the error is 401 and we haven't tried to refresh the token yet
        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;

          // If a refresh is already in progress, wait for it instead of starting another
          if (this.refreshTokenPromise) {
            try {
              await this.refreshTokenPromise;
            } catch {
              return Promise.reject(error);
            }
            // Retry with the new token from the completed refresh
            const newToken = this.auth.getAccessToken();
            if (newToken) {
              if (!originalRequest.headers) {
                originalRequest.headers = new AxiosHeaders();
              }
              originalRequest.headers.Authorization = `Bearer ${newToken}`;
              return this.axInstance(originalRequest);
            }
            return Promise.reject(error);
          }

          // First 401 — initiate the refresh
          this.refreshTokenPromise = (async () => {
            const refreshToken = this.auth.tokenManager.getRefreshToken();
            if (!refreshToken) {
              this.log.error('Cannot refresh token: No refresh token available.');
              this.triggerAuthFlow();
              throw new Error('No refresh token available for automatic refresh.');
            }
            const newTokenData = await this.auth.refreshTokens(refreshToken);
            await this.auth.tokenManager.updateTokens(newTokenData);
          })();

          try {
            await this.refreshTokenPromise;
            this.refreshTokenPromise = null;
            // Reset auth retry counter on successful refresh
            this.authFlowRetries = 0;

            const newToken = this.auth.getAccessToken();
            if (newToken) {
              if (!originalRequest.headers) {
                originalRequest.headers = new AxiosHeaders();
              }
              originalRequest.headers.Authorization = `Bearer ${newToken}`;
              return this.axInstance(originalRequest);
            }
          } catch (refreshError) {
            this.refreshTokenPromise = null;
            this.log.error('Token refresh failed:', refreshError);
            this.triggerAuthFlow();
            return Promise.reject(refreshError);
          }
        }

        return Promise.reject(error);
      },
    );

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('shutdown', () => {
      this.log.debug('Shutdown event received — cleaning up resources');
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

      try {
        // Check for crash loop BEFORE attempting any auth or API calls
        if (await this.crashLoopManager.isCrashLoopDetected(defaultCrashLoopConfig)) {
          this.log.warn('[CRASH LOOP DETECTED] Attempting to recover by clearing tokens and re-authenticating.');
          // Assuming auth is already initialized enough to call this method
          // Or SmartThingsAuth constructor needs to be robust enough if called before full init
          await this.auth.handleCrashLoopRecovery();
          // After attempting recovery, it's best to let Homebridge restart the plugin cleanly.
          // Or, if handleCrashLoopRecovery sets a state for re-auth, allow it to proceed.
          // For now, we'll log and let the user know. A manual restart of Homebridge might be needed
          // if the auth flow doesn't auto-trigger UI.
          this.log.warn('[CRASH LOOP RECOVERY] Token clearing initiated. Monitor logs for re-authentication steps.' +
            ' A Homebridge restart may be required.');
          // We might want to return here to prevent further execution in a potentially unstable state until re-auth completes.
          return;
        }

        // Initialize OAuth2 flow if needed and wait for it to complete
        const authFlowStarted = await this.auth.initialize();

        // Only proceed with device discovery if auth flow wasn't started and we have a valid token
        if (!authFlowStarted && this.auth.getAccessToken()) {
          // If locations or rooms to ignore are configured, then
          // load request those from Smartthings to build the id lists.
          if (this.config.IgnoreLocations) {
            await this.getLocationsToIgnore();
          }

          const devices = await this.withRetry(
            () => this.getOnlineDevices(),
            3,    // maxRetries
            3000, // baseDelayMs (3 seconds)
            'SmartThings device discovery',
          );
          if (this.config.UnregisterAll) {
            this.unregisterDevices(devices, true);
          }
          await this.discoverDevices(devices);
          this.unregisterDevices(devices);

          // Register Art Mode accessories for configured Frame TVs
          this.registerArtModeAccessories();

          // Set up real-time event handling if server_url is configured
          if (config.server_url && config.server_url.trim() !== '') {
            // Always create the event router so webhook-delivered events are handled
            this.subscriptionHandler = new SubscriptionHandler(this, this.accessoryObjects, webhookServer);

            // Attempt to set up SmartThings direct subscriptions (best-effort)
            await this.setupSmartThingsSubscriptions(devices, webhookServer);
          }
        } else if (authFlowStarted) {
          // If auth flow was started, log the waiting message
          this.log.info('Waiting for SmartThings authentication to complete...');
        } else {
          // Handle case where auth flow wasn't started but token is somehow still invalid (shouldn't happen often)
          this.log.error('Authentication failed or token invalid after initialization.');
        }
      } catch (error) {
        this.log.error('Error during platform initialization in didFinishLaunching:', error);
        // Record that an initialization error occurred.
        // If this error is one that leads to a crash and restart, it will be logged by CrashLoopManager.
        await this.crashLoopManager.recordPotentialCrash(CrashErrorType.API_INIT_FAILURE);
        this.log.error('Platform initialization failed. This might lead to a restart.' +
          ' If this persists, a crash loop recovery might be attempted.');
      }
    });
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
      // Record this critical failure as it prevents device discovery
      await this.crashLoopManager.recordPotentialCrash(CrashErrorType.API_INIT_FAILURE);
      throw error;
    }
  }

  unregisterDevices(devices, all = false) {
    const accessoriesToRemove: PlatformAccessory[] = [];

    //
    // Loop through each accessory.  If they are not present in the list
    // of current devices, then unregister them.
    //
    this.accessories.forEach(accessory => {
      if (all) {
        this.log.info('Unregistering all devices');
        this.log.info('Will unregister ' + accessory.context.device.label);
        accessoriesToRemove.push(accessory);
      }
      if (!devices.find(device => {
        return device.deviceId === accessory.UUID;
      })) {
        // Don't unregister Art Mode accessories — they use a derived UUID (deviceId + '-artmode')
        // and will be managed by registerArtModeAccessories()
        if (accessory.context.device?.deviceId?.endsWith('-artmode')) {
          return;
        }
        // Don't re-unregister TVs that were just migrated to external accessories
        // in discoverDevices() — their bridged cache entry is already gone.
        if (this.externalTvUuids.has(accessory.UUID)) {
          return;
        }
        this.log.info('Will unregister ' + accessory.context.device.label);
        accessoriesToRemove.push(accessory);
      }
    });

    if (accessoriesToRemove.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove);
    }
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices(devices) {
    const externalAccessories: PlatformAccessory[] = [];
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
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
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
        this.accessoryObjects.push(await this.createAccessoryObject(device, existingAccessory));
      } else {
        this.log.info('Registering new accessory: ' + device.label);

        const accessory = new this.api.platformAccessory(device.label, device.deviceId);
        accessory.context.device = device;

        this.accessoryObjects.push(await this.createAccessoryObject(device, accessory));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
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
    if (error instanceof Error) {
      const networkErrorCodes = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN'];
      const errorCode = (error as NodeJS.ErrnoException).code;
      return networkErrorCodes.includes(errorCode ?? '') ||
             error.message.includes('getaddrinfo') ||
             error.message.includes('timeout') ||
             error.message.includes('network');
    }
    return false;
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

