import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { InternalAxiosRequestConfig, AxiosHeaders } from 'axios';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import axios = require('axios');
//import { BasePlatformAccessory } from './basePlatformAccessory';
import { MultiServiceAccessory } from './multiServiceAccessory';
import { SubscriptionHandler } from './webhook/subscriptionHandler';
import { SmartThingsAuth } from './auth/auth';
import { WebhookServer } from './webhook/webhookServer';
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
            await this.auth.refreshTokens(refreshToken);

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

          // Start subscription service if we have a webhook token
          if (config.WebhookToken && config.WebhookToken !== '') {
            this.subscriptionHandler = new SubscriptionHandler(this, this.accessoryObjects, webhookServer);
            this.subscriptionHandler.startService();
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

  getOnlineDevices(): Promise<Array<object>> {
    this.log.debug('Discovering devices...');

    const command = 'devices';
    const devices: Array<object> = [];

    return new Promise<Array<object>>((resolve, reject) => {

      this.axInstance.get(command).then((res) => {
        res.data.items.forEach((device) => {
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

          // Check if device should be ignored
          if (this.config.IgnoreDevices && Array.isArray(this.config.IgnoreDevices)) {
            this.log.debug(`Checking if device "${deviceName}" should be ignored against list: [${this.config.IgnoreDevices.join(', ')}]`);

            const shouldIgnore = this.config.IgnoreDevices.find(ignoreName => {
              if (typeof ignoreName !== 'string') {
                this.log.warn(`Invalid ignore device entry: ${ignoreName} (expected string)`);
                return false;
              }
              // Normalize both names for comparison - handle special characters
              const normalizedIgnoreName = ignoreName.replace(/[\u2018\u2019]/g, '\'').replace(/[\u201C\u201D]/g, '"').toLowerCase().trim();
              const normalizedDeviceName = deviceName.toLowerCase().trim();

              this.log.debug(`Comparing normalized names: "${normalizedDeviceName}" vs "${normalizedIgnoreName}"`);
              return normalizedIgnoreName === normalizedDeviceName;
            });

            if (shouldIgnore) {
              this.log.info(`Ignoring ${device.label} because it is in the Ignore Devices list`);
              return;
            }
          } else if (this.config.IgnoreDevices) {
            this.log.warn('IgnoreDevices configuration is not an array. Expected format: ["Device Name 1", "Device Name 2"]');
          }

          if (!this.locationIDsToIgnore.find(locationID => device.locationId === locationID)) {
            this.log.debug('Pushing ' + device.label);
            devices.push(device);
          } else {
            this.log.info(`Ignoring ${device.label} because it is in a location to ignore (${device.locationId})`);
          }
        });
        this.log.debug('Stored all devices.');
        resolve(devices);
      }).catch(async error => {
        this.log.error('Error getting devices from Smartthings: ' + error);
        // Record this critical failure as it prevents device discovery
        await this.crashLoopManager.recordPotentialCrash(CrashErrorType.API_INIT_FAILURE);
        reject(error);
      });
    });
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

}

