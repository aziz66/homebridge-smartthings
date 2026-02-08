const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { AuthorizationCode } = require('simple-oauth2');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/authCode', this.authCode.bind(this));
    this.onRequest('/authToken', this.authToken.bind(this));
    this.onRequest('/clearTokens', this.clearTokens.bind(this));
    this.onRequest('/capabilities', this.getCapabilities.bind(this));
    this.onRequest('/resubscribe', this.resubscribe.bind(this));

    this.client = undefined;

    this.ready();
  }

  async authCode(config) {
    const params = {
      client: {
        id: config.clientId,
        secret: config.clientSecret,
      },
      auth: {
        tokenHost: 'https://api.smartthings.com',
        tokenPath: '/oauth/token',
        authorizePath: '/oauth/authorize',
      },
    };

    this.client = new AuthorizationCode(params);
    return this.client.authorizeURL({
      redirect_uri: config.redirectUrl,
      scope: config.scopes,
    });
  }

  async authToken(config) {
    try {
      const tokenParams = {
        code: config.code,
        redirect_uri: config.redirectUrl,
        scope: config.scopes,
      };
      const accessToken = await this.client.getToken(tokenParams);
      return accessToken.token;
    } catch (err) {
      throw new RequestError(err.message);
    }
  }

  async clearTokens() {
    try {
      const tokenPath = path.join(this.homebridgeStoragePath, 'smartthings_tokens.json');
      if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
        return { success: true, message: 'Token file cleared' };
      }
      return { success: true, message: 'No token file to clear' };
    } catch (err) {
      throw new RequestError('Failed to clear tokens: ' + err.message);
    }
  }

  async getCapabilities() {
    try {
      const filePath = path.join(this.homebridgeStoragePath, 'available_capabilities.json');
      if (!fs.existsSync(filePath)) {
        return { success: false, message: 'Capability list not yet available. The plugin writes this file after device discovery — restart Homebridge if needed.' };
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(data.capabilities) || typeof data.generatedAt !== 'string') {
        return { success: false, message: 'Capability file has an invalid format. Restart Homebridge to regenerate it.' };
      }
      return { success: true, capabilities: data.capabilities, generatedAt: data.generatedAt };
    } catch (err) {
      throw new RequestError('Failed to read capabilities: ' + err.message);
    }
  }

  async resubscribe(payload) {
    const capabilities = payload.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new RequestError('No capabilities provided');
    }
    if (capabilities.length > 20) {
      throw new RequestError('Maximum 20 capabilities allowed');
    }

    // Validate capability names against the discovered list
    const capFilePath = path.join(this.homebridgeStoragePath, 'available_capabilities.json');
    if (!fs.existsSync(capFilePath)) {
      throw new RequestError('Capability list not found. Restart Homebridge so the plugin can discover devices first.');
    }
    let knownCapabilities;
    try {
      const capData = JSON.parse(fs.readFileSync(capFilePath, 'utf8'));
      if (!Array.isArray(capData.capabilities)) {
        throw new Error('Invalid format');
      }
      knownCapabilities = new Set(capData.capabilities.map(c => c.name));
    } catch (err) {
      throw new RequestError('Failed to read capability list: ' + err.message);
    }
    const invalid = capabilities.filter(c => !knownCapabilities.has(c));
    if (invalid.length > 0) {
      throw new RequestError('Unknown capabilities: ' + invalid.join(', ') + '. Refresh the capability list and try again.');
    }

    // Read tokens file for access_token, installed_app_id, location_id
    const tokenPath = path.join(this.homebridgeStoragePath, 'smartthings_tokens.json');
    if (!fs.existsSync(tokenPath)) {
      throw new RequestError('Token file not found. Complete OAuth setup and restart Homebridge first.');
    }

    let tokens;
    try {
      tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    } catch (err) {
      throw new RequestError('Token file is corrupted. Clear tokens from the OAuth wizard and re-authenticate.');
    }
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
    const installedAppId = typeof tokens.installed_app_id === 'string' ? tokens.installed_app_id : '';
    const locationId = typeof tokens.location_id === 'string' ? tokens.location_id : '';

    if (!accessToken || !installedAppId || !locationId) {
      throw new RequestError('Missing required token data (access_token, installed_app_id, or location_id). Restart Homebridge to populate these values.');
    }

    const baseURL = 'https://api.smartthings.com/v1/';
    const headers = { Authorization: `Bearer ${accessToken}` };

    // Step 1: Flush existing subscriptions
    try {
      await axios.delete(`${baseURL}installedapps/${installedAppId}/subscriptions`, { headers });
    } catch (err) {
      throw new RequestError('Failed to flush existing subscriptions: ' + (err.response?.data?.message || err.message));
    }

    // Step 2: Create new subscriptions
    const errors = [];
    let successCount = 0;
    let failCount = 0;

    for (const capability of capabilities) {
      const subscriptionName = ('hb_' + capability).substring(0, 36);
      const body = {
        sourceType: 'CAPABILITY',
        capability: {
          locationId: locationId,
          capability: capability,
          attribute: '*',
          value: '*',
          stateChangeOnly: true,
          subscriptionName: subscriptionName,
        },
      };

      try {
        await axios.post(`${baseURL}installedapps/${installedAppId}/subscriptions`, body, { headers });
        successCount++;
      } catch (err) {
        failCount++;
        errors.push(`${capability}: ${err.response?.data?.message || err.message}`);
      }
    }

    return {
      success: failCount === 0,
      message: `Subscriptions updated: ${successCount} created, ${failCount} failed`,
      successCount,
      failCount,
      errors,
    };
  }
}

(() => {
  return new UiServer();
})();
