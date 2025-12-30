import { Logger } from 'homebridge';
import * as crypto from 'crypto';
import axios from 'axios';
import * as http from 'http';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { TokenManager, TokenData } from './tokenManager';
import { WebhookServer } from '../webhook/webhookServer';

const SMARTTHINGS_AUTH_URL = 'https://api.smartthings.com/oauth/authorize';
const SMARTTHINGS_TOKEN_URL = 'https://api.smartthings.com/oauth/token';

export class SmartThingsAuth {
  public tokenManager: TokenManager;
  private state: string | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly log: Logger,
    private readonly platform: IKHomeBridgeHomebridgePlatform,
    storagePath: string,
    private readonly webhookServer: WebhookServer,
  ) {
    this.tokenManager = new TokenManager(
      log,
      storagePath,
      this.startAuthFlow.bind(this),
      this.refreshTokens.bind(this),
      platform.config, // Pass config for OAuth wizard token loading
    );
    this.webhookServer.setAuthHandler(this);
  }

  public async handleOAuthCallback(query: any, res: http.ServerResponse): Promise<void> {
    try {
      if (!query.code || !query.state) {
        throw new Error('Missing code or state parameter');
      }

      if (query.state !== this.state) {
        throw new Error('Invalid state parameter');
      }

      const tokens = await this.exchangeCodeForTokens(query.code);
      await this.tokenManager.updateTokens(tokens);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication successful!</h1><p>You can close this window and restart Homebridge.</p>');

      this.log.info('Successfully authenticated with SmartThings');
    } catch (error) {
      this.log.error('OAuth callback error:', error);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication failed</h1><p>Please try again.</p>');
    }
  }

  private async exchangeCodeForTokens(code: string): Promise<any> {
    // Create Basic Auth header from client credentials
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    // Build redirect URI with optional port
    let redirectUri = this.platform.config.server_url;
    if (!redirectUri.endsWith('/')) {
      redirectUri += '/';
    }
    redirectUri += 'oauth/callback';

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', redirectUri);

    const response = await axios.post(SMARTTHINGS_TOKEN_URL, params, {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    return response.data;
  }

  // Accepts refreshToken, performs API call, returns new token data
  public async refreshTokens(refreshToken: string): Promise<Partial<TokenData>> {
    try {
      if (!refreshToken) {
        throw new Error('No refresh token provided to refreshTokens method');
      }

      this.log.debug('Attempting to refresh tokens via API call.');

      // Create Basic Auth header from client credentials
      const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', refreshToken);

      const response = await axios.post(SMARTTHINGS_TOKEN_URL, params, {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      this.log.info('Successfully obtained new tokens from API.');
      return response.data;

    } catch (error) {
      this.log.error('Error during token refresh API call:', error);
      throw error;
    }
  }

  public startAuthFlow(): void {
    // Check if server_url is configured (traditional flow with tunnel)
    if (this.platform.config.server_url && this.platform.config.server_url.trim() !== '') {
      this.state = crypto.randomBytes(32).toString('hex');

      const authUrl = new URL(SMARTTHINGS_AUTH_URL);
      authUrl.searchParams.append('client_id', this.clientId);
      authUrl.searchParams.append('response_type', 'code');

      // Build redirect URI with optional port
      let redirectUri = this.platform.config.server_url;
      if (!redirectUri.endsWith('/')) {
        redirectUri += '/';
      }
      redirectUri += 'oauth/callback';

      authUrl.searchParams.append('redirect_uri', redirectUri);
      authUrl.searchParams.append('scope', 'r:devices:* x:devices:* r:locations:*');
      authUrl.searchParams.append('state', this.state);

      this.log.warn('\n=================================================');
      this.log.warn('SmartThings Authentication Required');
      this.log.warn('Please visit this URL to authorize with SmartThings:');
      this.log.warn(authUrl.toString());
      this.log.warn('=================================================\n');
      this.log.warn('Restart Homebridge after authentication');
    } else {
      // No server_url - recommend using the OAuth wizard
      this.log.warn('\n=================================================');
      this.log.warn('SmartThings Authentication Required');
      this.log.warn('');
      this.log.warn('Please use the OAuth Setup Wizard in Homebridge UI:');
      this.log.warn('1. Go to Homebridge UI > Plugins > Settings for this plugin');
      this.log.warn('2. Click "Open OAuth Setup Wizard"');
      this.log.warn('3. Follow the wizard steps to complete authentication');
      this.log.warn('');
      this.log.warn('The wizard does not require a tunnel or public URL.');
      this.log.warn('=================================================\n');
    }
  }

  public async initialize(): Promise<boolean> {
    const accessToken = this.tokenManager.getAccessToken();
    let authFlowStarted = false;

    if (!accessToken || !this.tokenManager.isTokenValid()) {
      if (this.tokenManager.isRefreshTokenValid()) {
        try {
          const currentRefreshToken = this.tokenManager.getRefreshToken();
          if (currentRefreshToken) {
            await this.refreshTokens(currentRefreshToken);
          } else {
            this.log.warn('No refresh token found during initialization.');
            this.startAuthFlow();
            authFlowStarted = true;
          }
        } catch (error) {
          this.log.warn('Token refresh failed during initialization, starting auth flow.');
          this.startAuthFlow();
          authFlowStarted = true;
        }
      } else {
        this.startAuthFlow();
        authFlowStarted = true;
      }
    }
    return authFlowStarted; // Return true if auth flow was started
  }

  public getAccessToken(): string | null {
    return this.tokenManager.getAccessToken();
  }

  public async handleCrashLoopRecovery(): Promise<void> {
    this.log.warn('Handling crash loop recovery by clearing tokens and starting new auth flow.');
    try {
      // Clear existing tokens
      await this.tokenManager.clearTokens();
      this.log.info('Successfully cleared tokens during crash loop recovery.');

      // Start new auth flow
      this.startAuthFlow();
      this.log.info('Started new authentication flow for crash loop recovery.');
    } catch (error) {
      this.log.error('Error during crash loop recovery:', error);
      // Even if clearing fails, try to start auth flow
      this.startAuthFlow();
    }
  }
}