const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { AuthorizationCode } = require('simple-oauth2');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/authCode', this.authCode.bind(this));
    this.onRequest('/authToken', this.authToken.bind(this));

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
}

(() => {
  return new UiServer();
})();
