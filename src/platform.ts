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

  private accessoryObjects: MultiServiceAccessory[] = [];
  private subscriptionHandler: SubscriptionHandler | undefined = undefined;

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

    // Add response interceptor to handle 401 errors
    this.axInstance.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        // If the error is 401 and we haven't tried to refresh the token yet
        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;

          try {
            // Get the current refresh token
            const refreshToken = this.auth.tokenManager.getRefreshToken();
            if (!refreshToken) {
              this.log.error('Cannot refresh token: No refresh token available.');
              this.auth.startAuthFlow(); // Start auth flow if no refresh token
              return Promise.reject(new Error('No refresh token available for automatic refresh.'));
            }

            // Attempt to refresh the token using the specific token
            const newTokenData = await this.auth.refreshTokens(refreshToken);
            await this.auth.tokenManager.updateTokens(newTokenData);

            // Update the Authorization header with the new token
            const newToken = this.auth.getAccessToken();
            if (newToken) {
              if (!originalRequest.headers) {
                originalRequest.headers = new AxiosHeaders();
              }
              originalRequest.headers.Authorization = `Bearer ${newToken}`;
              // Retry the original request with the new token
              return this.axInstance(originalRequest);
            }
          } catch (refreshError) {
            this.log.error('Token refresh failed:', refreshError);
            // Start new auth flow if refresh fails
            this.auth.startAuthFlow();
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
          this.discoverDevices(devices);
          this.unregisterDevices(devices);

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
  discoverDevices(devices) {

    //
    //  for now, unregister all accessories first
    // REMOVE ME
    // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories);

    devices.forEach((device) => {

      this.log.debug('DEVICE DATA: ' + JSON.stringify(device));

      if (this.findSupportedCapability(device)) {
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === device.deviceId);

        if (existingAccessory) {
          // the accessory already exists
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

          // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
          // existingAccessory.context.device = device;
          // this.api.updatePlatformAccessories([existingAccessory]);

          // create the accessory handler for the restored accessory
          // this is imported from `platformAccessory.ts`
          this.accessoryObjects.push(this.createAccessoryObject(device, existingAccessory));

          // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
          // remove platform accessories when no longer present
          // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
          // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
        } else {
          // the accessory does not yet exist, so we need to create it
          this.log.info('Registering new accessory: ' + device.label);

          // create a new accessory
          const accessory = new this.api.platformAccessory(device.label, device.deviceId);

          // store a copy of the device object in the `accessory.context`
          // the `context` property can be used to store any data about the accessory you may need
          accessory.context.device = device;

          // create the accessory handler for the newly create accessory
          // this is imported from `platformAccessory.ts`

          this.accessoryObjects.push(this.createAccessoryObject(device, accessory));

          // link the accessory to your platform
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    });
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

  createAccessoryObject(device, accessory): MultiServiceAccessory {
    // const component = device.components.find(c => c.id === 'main');

    // let capabilities;
    // if (component) {
    //   capabilities = component.capabilities;
    // } else {
    //   capabilities = device.components[0].capabilities;
    // }

    const acc = new MultiServiceAccessory(this, accessory);
    device.components.forEach(component => {
      acc.addComponent(component.id, component.capabilities.map((c) => c.id));
    });

    return acc;
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

