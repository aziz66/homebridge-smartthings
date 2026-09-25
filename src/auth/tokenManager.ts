import { Logger, PlatformConfig } from 'homebridge';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import fsExtra from 'fs-extra';
import { describeError } from './sanitizeError';

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  refresh_token_expires_at: number;
  installed_app_id?: string;
  location_id?: string;
  // SHA-256 of the config (OAuth wizard) refresh token this file was seeded from, if any.
  seeded_from_config_refresh_token_sha256?: string;
}

/**
 * True when the token endpoint rejected the refresh itself (e.g. invalid_grant / invalid_client),
 * i.e. re-authorization is needed. Network failures, timeouts, 5xx and 429 are transient.
 */
export function isAuthRejection(error: unknown): boolean {
  const e = error as { response?: { status?: unknown }; noRefreshToken?: boolean } | null | undefined;
  if (e?.noRefreshToken === true) {
    return true;
  }
  const status = e?.response?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export class TokenManager {
  private tokenPath: string;
  private tokenData: TokenData | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly REFRESH_BEFORE_EXPIRY = 5 * 60 * 1000; // Refresh 5 minutes before expiry
  private readonly REFRESH_CHECK_INTERVAL = 60 * 1000; // Check every minute
  private startAuthFlowCallback: () => void;
  private refreshTokenApiCallback: (refreshToken: string) => Promise<Partial<TokenData>>;
  // The single in-flight refresh shared by every caller: with rotating refresh tokens, two
  // concurrent refreshes would burn the token (the second one gets invalid_grant).
  private refreshPromise: Promise<void> | null = null;
  private lastAuthPromptTime = 0;
  private readonly AUTH_PROMPT_INTERVAL = 10 * 60 * 1000;

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
    // Homebridge keeps the process alive; this timer alone should not.
    this.refreshTimer.unref?.();
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
        await this.refreshAccessToken();
        this.log.info('Successfully refreshed access token using API callback.');
      } catch (error) {
        this.log.error(`API token refresh failed: ${describeError(error)}`);
        if (isAuthRejection(error)) {
          // The refresh token itself was rejected: ask for re-authorization, but not every minute.
          if (now - this.lastAuthPromptTime >= this.AUTH_PROMPT_INTERVAL) {
            this.lastAuthPromptTime = now;
            this.log.warn('Starting new auth flow due to refresh failure.');
            this.startAuthFlowCallback();
          }
        } else {
          this.log.warn('Token refresh will be retried in a minute.');
        }
      }
    }
  }

  /**
   * Refresh the access token with the stored refresh token and persist the result. Concurrent
   * callers (the expiry monitor, the 401 interceptor, startup) share one in-flight request.
   */
  public refreshAccessToken(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) {
          throw Object.assign(new Error('No refresh token available'), { noRefreshToken: true });
        }
        const newTokenData = await this.refreshTokenApiCallback(refreshToken);
        await this.updateTokens(newTokenData);
      })().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private loadTokens(): void {
    try {
      const configRefreshToken = this.config?.oauth_refresh_token;
      const hasConfigTokens = !!(this.config?.oauth_access_token && configRefreshToken);

      // The token file normally wins: it holds the latest (rotated) tokens, which are never
      // written back to the config. The exception is a file seeded from an older wizard run:
      // if the wizard has since saved a different refresh token, the config is newer.
      if (fs.existsSync(this.tokenPath)) {
        const fileData = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
        const seed = fileData?.seeded_from_config_refresh_token_sha256;
        if (hasConfigTokens && typeof seed === 'string' && seed !== sha256(configRefreshToken)) {
          this.log.info('The OAuth wizard saved new tokens since the token file was created - using the tokens from the config');
          this.loadConfigTokens();
          return;
        }
        this.tokenData = fileData;
        this.log.debug('Loaded existing tokens from storage file');
        return;
      }

      // If no token file, check for tokens in config (OAuth wizard flow)
      if (hasConfigTokens) {
        this.loadConfigTokens();
      }
    } catch (error) {
      this.log.error('Error loading tokens:', error);
    }
  }

  private loadConfigTokens(): void {
    this.log.info('Loading tokens from config (OAuth wizard setup)');
    const expiresIn = this.config!.oauth_expires_in || 86400; // Use saved value or default to 24 hours
    this.tokenData = {
      access_token: this.config!.oauth_access_token,
      refresh_token: this.config!.oauth_refresh_token,
      expires_in: expiresIn,
      expires_at: Date.now() + expiresIn * 1000,
      refresh_token_expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
      seeded_from_config_refresh_token_sha256: sha256(this.config!.oauth_refresh_token),
    };
    // Save to token file for future use
    this.saveTokens();
    this.log.info('Tokens from OAuth wizard saved to storage file');
  }

  private saveTokens(): void {
    try {
      if (this.tokenData) {
        // Owner-only: the file holds the refresh token.
        fs.writeFileSync(this.tokenPath, JSON.stringify(this.tokenData, null, 2), { mode: 0o600 });
        try {
          fs.chmodSync(this.tokenPath, 0o600); // also tighten files created by older versions
        } catch {
          // Best effort (e.g. filesystems without POSIX permissions).
        }
        this.log.debug('Saved tokens to storage');
      }
    } catch (error) {
      this.log.error('Error saving tokens:', error);
    }
  }

  public async updateTokens(tokenData: Partial<TokenData>): Promise<void> {
    const oldAccessToken = this.tokenData?.access_token;
    const updated = {
      ...this.tokenData,
      ...tokenData,
    } as TokenData;
    // Only a new access token (or expiry) moves the access expiry, and only a new refresh token
    // moves the refresh expiry. Partial records such as { location_id } or { installed_app_id }
    // must not reset them, or the next check forces an unnecessary refresh.
    if (tokenData.access_token !== undefined || tokenData.expires_in !== undefined) {
      updated.expires_at = Date.now() + (tokenData.expires_in || 0) * 1000;
    }
    if (tokenData.refresh_token !== undefined) {
      updated.refresh_token_expires_at = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    }
    this.tokenData = updated;

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

  public getInstalledAppId(): string | null {
    return this.tokenData?.installed_app_id || null;
  }

  public getLocationId(): string | null {
    return this.tokenData?.location_id || null;
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