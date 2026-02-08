import { Logger } from 'homebridge';
import * as http from 'http';
import * as url from 'url';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { SmartThingsAuth } from '../auth/auth';
import { ShortEvent } from './subscriptionHandler';
import axios from 'axios';

export class WebhookServer {
  private server: http.Server | null = null;
  private eventHandlers: ((event: ShortEvent) => void)[] = [];
  private authHandler: SmartThingsAuth | null = null;
  private isRunning = false;

  constructor(
    private readonly platform: IKHomeBridgeHomebridgePlatform,
    private readonly log: Logger,
  ) {
    // Only start the webhook server if server_url is configured
    // This is needed for both OAuth callback (traditional flow) and device events
    if (this.platform.config.server_url && this.platform.config.server_url.trim() !== '') {
      this.startServer();
    } else {
      this.log.debug('Webhook server not started - no server_url configured. ' +
        'Real-time device updates via webhooks will not be available. ' +
        'Using polling mode instead.');
    }
  }

  private startServer(): void {
    const port = this.platform.config.webhook_port || 3000;

    this.server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url!, true);

      if (parsedUrl.pathname === '/oauth/callback') {
        if (this.authHandler) {
          this.handleOAuthCallback(parsedUrl.query, res);
        } else {
          this.log.error('OAuth callback received but no auth handler registered');
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<h1>Error: OAuth handler not initialized</h1>');
        }
      } else if (parsedUrl.pathname === '/') {
        this.handleIncomingPost(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.listen(port, () => {
      this.log.info(`Webhook server listening on port ${port}`);
      this.isRunning = true;
    });

    this.server.on('error', (error) => {
      this.log.error('Webhook server error:', error);
    });
  }

  public setAuthHandler(auth: SmartThingsAuth): void {
    this.authHandler = auth;
  }

  private async handleOAuthCallback(query: any, res: http.ServerResponse): Promise<void> {
    try {
      if (!this.authHandler) {
        throw new Error('No auth handler registered');
      }
      await this.authHandler.handleOAuthCallback(query, res);
    } catch (error) {
      this.log.error('OAuth callback error:', error);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication failed</h1><p>Please try again.</p>');
    }
  }

  private async handleIncomingPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);

          // Detect SmartThings lifecycle format
          // SmartApps use "lifecycle", API_ONLY/Connected Service apps use "messageType"
          const lifecycleType = parsed.lifecycle || parsed.messageType;
          if (lifecycleType) {
            parsed.lifecycle = lifecycleType; // Normalize to "lifecycle" for handler
            this.handleSmartThingsLifecycle(parsed, res);
          } else if (parsed.deviceId && parsed.capability) {
            // Legacy direct ShortEvent format (for compatibility)
            this.notifyEventHandlers(parsed as ShortEvent);
            res.writeHead(200);
            res.end();
          } else {
            this.log.debug('Received unknown POST format on /, ignoring');
            res.writeHead(200);
            res.end();
          }
        } catch (error) {
          this.log.error('Error parsing incoming POST body:', error);
          res.writeHead(400);
          res.end();
        }
      });
    } catch (error) {
      this.log.error('Error handling incoming POST:', error);
      res.writeHead(500);
      res.end();
    }
  }

  private handleSmartThingsLifecycle(body: any, res: http.ServerResponse): void {
    const lifecycle = body.lifecycle;
    this.log.debug(`Received SmartThings lifecycle event: ${lifecycle}`);

    switch (lifecycle) {
      case 'PING':
        this.handlePing(body, res);
        break;
      case 'CONFIRMATION':
        this.handleConfirmation(body, res);
        break;
      case 'EVENT':
        this.handleEventLifecycle(body, res);
        break;
      case 'INSTALL':
        this.handleInstall(body, res);
        break;
      case 'CONFIGURATION':
      case 'UPDATE':
      case 'UNINSTALL':
        this.log.debug(`Received ${lifecycle} lifecycle event - acknowledging`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        break;
      default:
        this.log.debug(`Received unknown lifecycle event: ${lifecycle} - acknowledging`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        break;
    }
  }

  private handlePing(body: any, res: http.ServerResponse): void {
    const challenge = body.pingData?.challenge;
    if (challenge) {
      this.log.info('Received SmartThings PING challenge - responding');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pingData: { challenge } }));
    } else {
      this.log.error('Received PING lifecycle without challenge data');
      res.writeHead(400);
      res.end();
    }
  }

  private handleConfirmation(body: any, res: http.ServerResponse): void {
    const confirmationUrl = body.confirmationData?.confirmationUrl;
    if (confirmationUrl) {
      this.log.info('Received SmartThings CONFIRMATION - hitting confirmation URL');
      axios.get(confirmationUrl)
        .then(() => {
          this.log.info('Successfully confirmed SmartThings app registration');
        })
        .catch((error) => {
          this.log.error('Failed to confirm SmartThings app registration:', error);
        });
      const serverUrl = this.platform.config.server_url || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ targetUrl: serverUrl }));
    } else {
      this.log.error('Received CONFIRMATION lifecycle without confirmationUrl');
      res.writeHead(400);
      res.end();
    }
  }

  private handleEventLifecycle(body: any, res: http.ServerResponse): void {
    const eventData = body.eventData;

    // Capture installedAppId and locationId from event envelope if available
    if (eventData?.installedApp) {
      const { installedAppId, locationId } = eventData.installedApp;
      if (installedAppId || locationId) {
        this.persistSmartThingsIds(installedAppId, locationId);
      }
    }

    // Process device events
    const events = eventData?.events;
    if (Array.isArray(events)) {
      let eventCount = 0;
      for (const item of events) {
        if (item.eventType === 'DEVICE_EVENT' && item.deviceEvent) {
          const de = item.deviceEvent;
          const shortEvent: ShortEvent = {
            deviceId: de.deviceId,
            componentId: de.componentId,
            capability: de.capability,
            attribute: de.attribute,
            value: de.value,
          };
          this.log.debug(`SmartThings event: ${de.deviceId} ${de.capability}.${de.attribute} = ${JSON.stringify(de.value)}`);
          this.notifyEventHandlers(shortEvent);
          eventCount++;
        }
      }
      this.log.debug(`Processed ${eventCount} device events from SmartThings EVENT lifecycle`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ eventData: {} }));
  }

  private handleInstall(body: any, res: http.ServerResponse): void {
    this.log.info('Received SmartThings INSTALL lifecycle event');

    // Capture installedAppId from INSTALL event
    const installedAppId = body.installData?.installedApp?.installedAppId;
    const locationId = body.installData?.installedApp?.locationId;
    if (installedAppId || locationId) {
      this.persistSmartThingsIds(installedAppId, locationId);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
  }

  private persistSmartThingsIds(installedAppId?: string, locationId?: string): void {
    const tokenManager = this.platform.auth?.tokenManager;
    if (!tokenManager) {
      return;
    }

    const currentAppId = tokenManager.getInstalledAppId();
    const currentLocationId = tokenManager.getLocationId();

    const updates: any = {};
    if (installedAppId && installedAppId !== currentAppId) {
      updates.installed_app_id = installedAppId;
      this.log.info(`Captured installedAppId from lifecycle event: ${installedAppId}`);
    }
    if (locationId && locationId !== currentLocationId) {
      updates.location_id = locationId;
      this.log.info(`Captured locationId from lifecycle event: ${locationId}`);
    }

    if (Object.keys(updates).length > 0) {
      tokenManager.updateTokens(updates);
    }
  }

  public addEventHandler(handler: (event: ShortEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  private notifyEventHandlers(event: ShortEvent): void {
    this.eventHandlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        this.log.error('Error in event handler:', error);
      }
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.isRunning = false;
    }
  }

  public isServerRunning(): boolean {
    return this.isRunning;
  }
}
