import { Logger } from 'homebridge';
import * as http from 'http';
import * as url from 'url';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { SmartThingsAuth } from '../auth/auth';
import { ShortEvent } from './subscriptionHandler';

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
        this.handleDeviceEvent(req, res);
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

  private async handleDeviceEvent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          const event = JSON.parse(body) as ShortEvent;
          this.notifyEventHandlers(event);
          res.writeHead(200);
          res.end();
        } catch (error) {
          this.log.error('Error parsing device event:', error);
          res.writeHead(400);
          res.end();
        }
      });
    } catch (error) {
      this.log.error('Error handling device event:', error);
      res.writeHead(500);
      res.end();
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