import WebSocket from 'ws';
import { Logger } from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';

export class SamsungWebSocket {
  private readonly ip: string;
  private readonly log: Logger;
  private readonly appName: string;
  private readonly storagePath: string;
  private token: string | null;
  private remoteWs: WebSocket | null = null;
  private artWs: WebSocket | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs = 8000;
  private connecting = false;
  private artConnecting = false;

  constructor(ip: string, log: Logger, storagePath: string, token?: string, appName = 'Homebridge SmartThings') {
    this.ip = ip;
    this.log = log;
    this.appName = appName;
    this.storagePath = storagePath;
    this.token = token || null;

    // Try to load a previously saved token if none was provided
    if (!this.token) {
      this.token = this.loadToken();
    }
  }

  private get encodedAppName(): string {
    return Buffer.from(this.appName).toString('base64');
  }

  private get remoteUrl(): string {
    let url = `wss://${this.ip}:8002/api/v2/channels/samsung.remote.control?name=${this.encodedAppName}`;
    if (this.token) {
      url += `&token=${this.token}`;
    }
    return url;
  }

  private get artModeUrl(): string {
    // Art mode channel uses unencrypted WS on port 8001 (no token needed)
    return `ws://${this.ip}:8001/api/v2/channels/com.samsung.art-app?name=${this.encodedAppName}`;
  }

  private get tokenFilePath(): string {
    // Sanitize IP for filename
    const safeIp = this.ip.replace(/[^a-zA-Z0-9.-]/g, '_');
    return path.join(this.storagePath, `samsung_tv_token_${safeIp}.json`);
  }

  private loadToken(): string | null {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.tokenFilePath, 'utf-8'));
        if (data.token) {
          this.log.debug(`Samsung WebSocket: Loaded saved token for ${this.ip}`);
          return data.token;
        }
      }
    } catch (err) {
      this.log.debug(`Samsung WebSocket: Could not load saved token for ${this.ip}: ${err}`);
    }
    return null;
  }

  private saveToken(token: string): void {
    try {
      fs.writeFileSync(this.tokenFilePath, JSON.stringify({ token, ip: this.ip, savedAt: new Date().toISOString() }));
      this.log.info(`Samsung WebSocket: Token saved for ${this.ip} — future connections will skip TV authorization popup`);
    } catch (err) {
      this.log.warn(`Samsung WebSocket: Could not save token for ${this.ip}: ${err}`);
    }
  }

  private handleConnectMessage(msg: any): void {
    // Samsung TVs return a token in the ms.channel.connect event data
    // This token must be saved and used for future connections to skip the Allow/Deny popup
    const tokenFromTv = msg.data?.token;
    if (tokenFromTv && tokenFromTv !== this.token) {
      this.log.info(`Samsung WebSocket: Received authorization token from TV at ${this.ip}`);
      this.token = tokenFromTv;
      this.saveToken(tokenFromTv);
    }
  }

  private connectRemote(connectTimeoutOverride?: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (this.remoteWs && this.remoteWs.readyState === WebSocket.OPEN) {
        this.resetIdleTimer();
        resolve(this.remoteWs);
        return;
      }

      if (this.connecting) {
        let waitElapsed = 0;
        const waitInterval = setInterval(() => {
          waitElapsed += 100;
          if (!this.connecting) {
            clearInterval(waitInterval);
            if (this.remoteWs && this.remoteWs.readyState === WebSocket.OPEN) {
              resolve(this.remoteWs);
            } else {
              reject(new Error('Remote WebSocket connection failed while waiting'));
            }
          } else if (waitElapsed >= 30000) {
            clearInterval(waitInterval);
            reject(new Error('Remote WebSocket: timed out waiting for existing connection attempt'));
          }
        }, 100);
        return;
      }

      this.connecting = true;
      const hasToken = !!this.token;
      this.log.debug(`Samsung WebSocket: Connecting to remote control at ${this.ip}:8002 (token=${hasToken ? 'yes' : 'NO — TV will show Allow/Deny popup'})`);

      if (!hasToken) {
        this.log.warn(
          `Samsung WebSocket: No saved token for ${this.ip}. ` +
          'The TV will display an "Allow" popup. Please accept it on the TV screen. ' +
          'The token will be saved automatically for future connections.',
        );
      }

      const ws = new WebSocket(this.remoteUrl, { rejectUnauthorized: false });

      // Give extra time for first-time authorization (user needs to press Allow on TV)
      const timeoutMs = connectTimeoutOverride ?? (hasToken ? 5000 : 30000);
      const connectTimeout = setTimeout(() => {
        this.connecting = false;
        ws.terminate();
        const msg = hasToken
          ? `Samsung WebSocket: Connection timeout to ${this.ip} (TV may be off)`
          : `Samsung WebSocket: Connection timeout to ${this.ip} — did you accept the "Allow" popup on the TV?`;
        reject(new Error(msg));
      }, timeoutMs);

      ws.on('open', () => {
        this.log.debug(`Samsung WebSocket: TCP connected to ${this.ip}:8002, waiting for channel connect...`);
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.event === 'ms.channel.connect') {
            clearTimeout(connectTimeout);
            this.handleConnectMessage(msg);
            this.log.debug('Samsung WebSocket: Remote control channel connected');
            this.remoteWs = ws;
            this.connecting = false;
            this.resetIdleTimer();
            resolve(ws);
          } else if (msg.event === 'ms.channel.unauthorized') {
            clearTimeout(connectTimeout);
            this.connecting = false;
            ws.terminate();
            // Token is invalid/expired — clear it so next attempt shows popup
            this.token = null;
            try { fs.unlinkSync(this.tokenFilePath); } catch { /* ignore */ }
            reject(new Error(
              `Samsung WebSocket: Authorization denied by TV at ${this.ip}. ` +
              'Saved token was invalid. Restart Homebridge to retry — the TV will show a new Allow/Deny popup.',
            ));
          }
        } catch {
          // Ignore non-JSON messages
        }
      });

      ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        this.connecting = false;
        this.log.error(`Samsung WebSocket: Remote connection error: ${err.message}`);
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(connectTimeout);
        this.connecting = false;
        if (this.remoteWs === ws) {
          this.remoteWs = null;
        }
        this.log.debug('Samsung WebSocket: Remote control connection closed');
      });
    });
  }

  private connectArtMode(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (this.artWs && this.artWs.readyState === WebSocket.OPEN) {
        resolve(this.artWs);
        return;
      }

      if (this.artConnecting) {
        let waitElapsed = 0;
        const waitInterval = setInterval(() => {
          waitElapsed += 100;
          if (!this.artConnecting) {
            clearInterval(waitInterval);
            if (this.artWs && this.artWs.readyState === WebSocket.OPEN) {
              resolve(this.artWs);
            } else {
              reject(new Error('Art mode WebSocket connection failed while waiting'));
            }
          } else if (waitElapsed >= 10000) {
            clearInterval(waitInterval);
            reject(new Error('Art mode WebSocket: timed out waiting for existing connection attempt'));
          }
        }, 100);
        return;
      }

      this.artConnecting = true;
      this.log.debug(`Samsung WebSocket: Connecting to art mode channel at ${this.ip}:8001`);

      const ws = new WebSocket(this.artModeUrl);

      const connectTimeout = setTimeout(() => {
        this.artConnecting = false;
        ws.terminate();
        reject(new Error(`Samsung WebSocket: Art mode connection timeout to ${this.ip}`));
      }, 5000);

      ws.on('open', () => {
        this.log.debug(`Samsung WebSocket: TCP connected to art mode channel at ${this.ip}:8001`);
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.event === 'ms.channel.connect') {
            // Art channel on port 8001 may also return a token
            this.handleConnectMessage(msg);
            this.log.debug('Samsung WebSocket: Art mode channel connected');
          } else if (msg.event === 'ms.channel.ready') {
            // Reference: samsung-tizen plugin resolves on ms.channel.ready
            clearTimeout(connectTimeout);
            clearTimeout(fallbackTimeout);
            if (!this.artWs) {
              this.artWs = ws;
              this.artConnecting = false;
              resolve(ws);
            }
          } else if (msg.event === 'd2d_service_message') {
            clearTimeout(connectTimeout);
            clearTimeout(fallbackTimeout);
            if (!this.artWs) {
              this.artWs = ws;
              this.artConnecting = false;
              resolve(ws);
            }
          }
        } catch {
          // Ignore non-JSON messages
        }
      });

      // Fallback: some TVs don't send a connect message on the art channel
      const fallbackTimeout = setTimeout(() => {
        if (!this.artWs && ws.readyState === WebSocket.OPEN) {
          clearTimeout(connectTimeout);
          this.artWs = ws;
          this.artConnecting = false;
          resolve(ws);
        }
      }, 2000);

      ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        clearTimeout(fallbackTimeout);
        this.artConnecting = false;
        this.log.error(`Samsung WebSocket: Art mode connection error: ${err.message}`);
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(connectTimeout);
        clearTimeout(fallbackTimeout);
        this.artConnecting = false;
        if (this.artWs === ws) {
          this.artWs = null;
        }
        this.log.debug('Samsung WebSocket: Art mode connection closed');
      });
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.disconnectRemote();
    }, this.idleTimeoutMs);
  }

  private disconnectRemote(): void {
    if (this.remoteWs) {
      this.log.debug('Samsung WebSocket: Disconnecting remote (idle timeout)');
      this.remoteWs.close();
      this.remoteWs = null;
    }
  }

  private disconnectArt(): void {
    if (this.artWs) {
      this.log.debug('Samsung WebSocket: Disconnecting art mode');
      this.artWs.close();
      this.artWs = null;
    }
  }

  private sendKey(ws: WebSocket, cmd: 'Click' | 'Press' | 'Release', key: string): void {
    if (ws.readyState !== WebSocket.OPEN) {
      this.log.warn(`Samsung WebSocket: Cannot send key ${cmd} ${key} — WebSocket not open (state=${ws.readyState})`);
      return;
    }
    const payload = JSON.stringify({
      method: 'ms.remote.control',
      params: {
        Cmd: cmd,
        DataOfCmd: key,
        Option: false,
        TypeOfRemote: 'SendRemoteKey',
      },
    });
    this.log.debug(`Samsung WebSocket: Sending key ${cmd} ${key}`);
    ws.send(payload);
  }

  /**
   * Send a click (short press) of a key
   */
  async clickKey(key: string): Promise<void> {
    const ws = await this.connectRemote();
    this.sendKey(ws, 'Click', key);
  }

  /**
   * Hold a key for the specified duration (press, wait, release)
   * Used for Frame TV full power off (3.5s hold of KEY_POWER)
   * Uses a shorter connect timeout (2s) since this is called from HomeKit handlers with ~10s budget
   */
  async holdKey(key: string, durationMs: number): Promise<void> {
    const ws = await this.connectRemote(2000);
    this.sendKey(ws, 'Press', key);
    await new Promise<void>(resolve => setTimeout(resolve, durationMs));
    this.sendKey(ws, 'Release', key);
    this.log.debug(`Samsung WebSocket: Held ${key} for ${durationMs}ms`);
  }

  /**
   * Get current art mode status
   * Returns 'on' or 'off'
   */
  async getArtModeStatus(): Promise<string> {
    const ws = await this.connectArtMode();

    return new Promise<string>((resolve) => {
      const messageHandler = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.event === 'd2d_service_message' && msg.data) {
            const eventData = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            if (eventData.event === 'art_mode_changed' || eventData.event === 'artmode_status') {
              clearTimeout(timeout);
              ws.removeListener('message', messageHandler);
              const status = eventData.value === 'on' || eventData.status === 'on' ? 'on' : 'off';
              this.log.debug(`Samsung WebSocket: Art mode status: ${status}`);
              this.disconnectArt();
              resolve(status);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      const timeout = setTimeout(() => {
        ws.removeListener('message', messageHandler);
        this.disconnectArt();
        // Default to 'off' if we can't determine status
        resolve('off');
      }, 3000);

      ws.on('message', messageHandler);

      // Request art mode status
      const request = JSON.stringify({
        method: 'ms.channel.emit',
        params: {
          event: 'art_app_request',
          to: 'host',
          data: JSON.stringify({
            request: 'get_artmode_status',
            id: String(Date.now()),
          }),
        },
      });

      try {
        ws.send(request);
      } catch (err) {
        clearTimeout(timeout);
        ws.removeListener('message', messageHandler);
        this.log.error(`Samsung WebSocket: Failed to send art mode status request: ${err}`);
        this.disconnectArt();
        resolve('off');
      }
    });
  }

  /**
   * Set art mode status ('on' or 'off')
   */
  async setArtModeStatus(status: 'on' | 'off'): Promise<void> {
    const ws = await this.connectArtMode();

    if (ws.readyState !== WebSocket.OPEN) {
      this.log.warn(`Samsung WebSocket: Cannot set art mode — WebSocket not open (state=${ws.readyState})`);
      this.disconnectArt();
      return;
    }

    const request = JSON.stringify({
      method: 'ms.channel.emit',
      params: {
        event: 'art_app_request',
        to: 'host',
        data: JSON.stringify({
          request: 'set_artmode_status',
          value: status,
          id: String(Date.now()),
        }),
      },
    });

    this.log.debug(`Samsung WebSocket: Setting art mode to ${status}`);
    try {
      ws.send(request);
    } catch (err) {
      this.log.error(`Samsung WebSocket: Failed to send art mode command: ${err}`);
      this.disconnectArt();
      return;
    }

    // Give the TV a moment to process, then disconnect
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    this.disconnectArt();
  }

  /**
   * Clean up all connections
   */
  destroy(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.disconnectRemote();
    this.disconnectArt();
    this.log.debug('Samsung WebSocket: All connections closed');
  }
}
