import { Logger, PlatformConfig } from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';
import fsExtra from 'fs-extra';

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  refresh_token_expires_at: number;
  installed_app_id?: string;
  location_id?: string;
}

export class TokenManager {
  private tokenPath: string;
  private tokenData: TokenData | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly REFRESH_BEFORE_EXPIRY = 5 * 60 * 1000; // Refresh 5 minutes before expiry
  private readonly REFRESH_CHECK_INTERVAL = 60 * 1000; // Check every minute
  private startAuthFlowCallback: () => void;
  private refreshTokenApiCallback: (refreshToken: string) => Promise<Partial<TokenData>>;

  constructor(
    private readonly log: Logger,
    storagePath: string,
    startAuthFlowCallback: () => void,
    refreshTokenApiCallback: (refreshToken: string) => Promise<Partial<TokenData>>,
    private readonly config?: PlatformConfig,
  ) {
    this.tokenPath = path.join(storagePath, 'smartthings_tokens.json');
    this.startAuthFlowCallback = startAuthFlowCallback;
    this.refreshTokenApiCallback = refreshTokenApiCallback;
    this.loadTokens();
    this.startRefreshMonitor();
  }

  private startRefreshMonitor(): void {
    // Clear any existing timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // Start a periodic check for token refresh
    this.refreshTimer = setInterval(() => {
      this.checkAndRefreshTokens();
    }, this.REFRESH_CHECK_INTERVAL);
  }

  private async checkAndRefreshTokens(): Promise<void> {
    // Only proceed if we actually have token data AND a refresh token
    if (!this.tokenData || !this.tokenData.refresh_token) {
      this.log.debug('checkAndRefreshTokens: Skipping refresh check as token data or refresh token is missing.');
      return;
    }

    const now = Date.now();
    const timeUntilExpiry = this.tokenData.expires_at - now;

    // If access token is about to expire, refresh it
    if (timeUntilExpiry <= this.REFRESH_BEFORE_EXPIRY) {
      this.log.debug('Access token is about to expire, refreshing tokens');
      try {
        const currentRefreshToken = this.getRefreshToken();
        // Call the API callback with the current refresh token
        const newTokenData = await this.refreshTokenApiCallback(currentRefreshToken!);
        // Update internal tokens with the result from the API call
        await this.updateTokens(newTokenData);
        this.log.info('Successfully refreshed access token using API callback.');
      } catch (error) {
        // If the API callback fails (e.g., invalid refresh token), trigger full auth flow
        this.log.error('API token refresh failed:', error);
        this.log.warn('Starting new auth flow due to refresh failure.');
        this.startAuthFlowCallback();
      }
    }
  }

  private loadTokens(): void {
    try {
      // First try to load from token file (existing flow)
      if (fs.existsSync(this.tokenPath)) {
        const data = fs.readFileSync(this.tokenPath, 'utf8');
        this.tokenData = JSON.parse(data);
        this.log.debug('Loaded existing tokens from storage file');
        return;
      }

      // If no token file, check for tokens in config (OAuth wizard flow)
      if (this.config?.oauth_access_token && this.config?.oauth_refresh_token) {
        this.log.info('Loading tokens from config (OAuth wizard setup)');
        this.tokenData = {
          access_token: this.config.oauth_access_token,
          refresh_token: this.config.oauth_refresh_token,
          expires_in: 86400, // Assume 24 hours if not specified
          expires_at: Date.now() + 86400 * 1000, // Assume valid for 24 hours initially
          refresh_token_expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
        };
        // Save to token file for future use
        this.saveTokens();
        this.log.info('Tokens from OAuth wizard saved to storage file');
      }
    } catch (error) {
      this.log.error('Error loading tokens:', error);
    }
  }

  private saveTokens(): void {
    try {
      if (this.tokenData) {
        fs.writeFileSync(this.tokenPath, JSON.stringify(this.tokenData, null, 2));
        this.log.debug('Saved tokens to storage');
      }
    } catch (error) {
      this.log.error('Error saving tokens:', error);
    }
  }

  public async updateTokens(tokenData: Partial<TokenData>): Promise<void> {
    const oldAccessToken = this.tokenData?.access_token;
    this.tokenData = {
      ...this.tokenData,
      ...tokenData,
      expires_at: Date.now() + (tokenData.expires_in || 0) * 1000,
      refresh_token_expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    } as TokenData;

    // Save tokens first
    this.saveTokens();

    // Update platform config only if access token actually changed
    if (tokenData.access_token && tokenData.access_token !== oldAccessToken) {
      // This part requires access to platform.config and platform.api,
      // which we no longer directly have. This needs rethinking.
      // For now, commenting out the config update.
      // TODO: Find a way to update platform config without circular dependency.
      /*
      try {
        // Save the updated config to disk
        const configPath = this.platform.api.user.configPath();
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Find and update our platform's config
        const platformConfig = config.platforms.find(p =>
          p.platform === 'HomeBridgeSmartThings' && p.name === this.platform.config.name
        );

        if (platformConfig) {
          platformConfig.AccessToken = tokenData.access_token;
          fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
          this.log.debug('Updated AccessToken in Homebridge config');
        }
      } catch (error) {
        this.log.error('Error updating platform config:', error);
      }
      */
    }
  }

  public getAccessToken(): string | null {
    return this.tokenData?.access_token || null;
  }

  public getRefreshToken(): string | null {
    return this.tokenData?.refresh_token || null;
  }

  public isTokenValid(): boolean {
    if (!this.tokenData) {
return false;
}
    return Date.now() < (this.tokenData.expires_at - this.REFRESH_BEFORE_EXPIRY);
  }

  public isRefreshTokenValid(): boolean {
    if (!this.tokenData) {
return false;
}
    return Date.now() < (this.tokenData.refresh_token_expires_at - this.REFRESH_BEFORE_EXPIRY);
  }

  public async clearTokens(): Promise<void> {
    try {
      if (await fsExtra.pathExists(this.tokenPath)) {
        await fsExtra.remove(this.tokenPath);
        this.log.info('Successfully cleared stored tokens.');
        // Reset in-memory tokens as well
        this.tokenData = null;
        if (this.refreshTimer) {
          clearInterval(this.refreshTimer);
        }
      } else {
        this.log.info('No stored tokens file found to clear.');
      }
    } catch (error) {
      this.log.error('Error clearing tokens:', error);
      // Optionally re-throw or handle as appropriate for your plugin's error strategy
      throw error;
    }
  }

  public getTokenExpiryInfo(): { accessTokenExpiresIn: number; refreshTokenExpiresIn: number } {
    if (!this.tokenData) {
      return { accessTokenExpiresIn: 0, refreshTokenExpiresIn: 0 };
    }

    const now = Date.now();
    return {
      accessTokenExpiresIn: Math.max(0, this.tokenData.expires_at - now),
      refreshTokenExpiresIn: Math.max(0, this.tokenData.refresh_token_expires_at - now),
    };
  }
}