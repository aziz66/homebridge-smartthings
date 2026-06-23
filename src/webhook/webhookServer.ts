import { Logger } from 'homebridge';
import * as http from 'http';
import * as url from 'url';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { SmartThingsAuth } from '../auth/auth';
import { ShortEvent } from './subscriptionHandler';
import { SignatureVerifier } from './signatureVerifier';
import axios from 'axios';

// Lifecycles we process when signature verification is enabled. Anything else is dropped (400).
const KNOWN_LIFECYCLES = ['PING', 'CONFIRMATION', 'INSTALL', 'UPDATE', 'UNINSTALL', 'CONFIGURATION', 'EVENT'];
// Cap the inbound body on the public webhook endpoint. SmartThings lifecycle payloads are well under 1 KB.
const MAX_BODY_BYTES = 1024 * 1024;

export class WebhookServer {
  private server: http.Server | null = null;
  private eventHandlers: ((event: ShortEvent) => void)[] = [];
  private authHandler: SmartThingsAuth | null = null;
  private isRunning = false;
  private verifyEnabled = false;
  private signatureVerifier: SignatureVerifier | null = null;

  constructor(
    private readonly platform: IKHomeBridgeHomebridgePlatform,
    private readonly log: Logger,
  ) {
    // Opt-in HTTP signature verification of inbound SmartThings webhooks.
    if (this.platform.config.verifyWebhookSignatures === true) {
      const serverUrl = (this.platform.config.server_url || '').trim();
      if (serverUrl === '') {
        // Polling-only setup: the webhook server never starts, so the flag is a harmless no-op.
        this.log.debug('verifyWebhookSignatures is set but no Server URL is configured - this setting only ' +
          'applies to the webhook route, so it has no effect in polling mode.');
      } else if (serverUrl.toLowerCase().startsWith('https://')) {
        this.verifyEnabled = true;
        this.signatureVerifier = new SignatureVerifier(this.log);
        this.log.info('Webhook signature verification is ENABLED - unsigned/invalid requests will be rejected with 401');
      } else {
        this.log.error('verifyWebhookSignatures is enabled but Server URL is not https. ' +
          'Signature verification is DISABLED for this run. Set an https Server URL to enable it.');
      }
    }
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
      // Accumulate as Buffer so signature verification can hash the exact received bytes.
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;
      req.on('data', chunk => {
        if (aborted) {
          return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_BODY_BYTES) {
          // Guard a public endpoint against memory exhaustion. SmartThings payloads are tiny.
          aborted = true;
          this.log.warn('Rejected webhook POST on / - request body exceeds size limit (413)');
          res.writeHead(413);
          res.end();
          req.destroy();
          return;
        }
        chunks.push(buf);
      });

      req.on('end', () => {
        if (aborted) {
          return;
        }
        const rawBody = Buffer.concat(chunks);
        if (this.verifyEnabled) {
          this.handleVerifiedPost(rawBody, req, res).catch(error => {
            this.log.error('Error handling verified webhook POST:', error);
            if (!res.writableEnded) {
              res.writeHead(500);
              res.end();
            }
          });
        } else {
          this.handleLegacyPost(rawBody.toString(), res);
        }
      });
    } catch (error) {
      this.log.error('Error handling incoming POST:', error);
      res.writeHead(500);
      res.end();
    }
  }

  // Unauthenticated path (default). Behavior is unchanged from prior releases: every
  // non-error case acks with 200 so SmartThings never marks a delivery as failed.
  private handleLegacyPost(body: string, res: http.ServerResponse): void {
    // Empty POSTs (tunnel/SmartThings health checks) must be acked, not 400'd —
    // a 400 can be treated by SmartThings as a failed lifecycle delivery.
    if (body.trim() === '') {
      this.log.debug('Received empty POST body on /, acknowledging');
      res.writeHead(200);
      res.end();
      return;
    }

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
      // Malformed body — ack with 200 so SmartThings doesn't mark a lifecycle
      // delivery as failed; log for visibility.
      this.log.warn('Received unparseable POST body on /, acknowledging:', error);
      res.writeHead(200);
      res.end();
    }
  }

  // Verified path (verifyWebhookSignatures enabled). Rejects anything without a valid
  // SmartThings HTTP signature with 401, and only dispatches known lifecycles.
  private async handleVerifiedPost(rawBody: Buffer, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = url.parse(req.url || '/').pathname || '/';
    const ok = await this.signatureVerifier!.verify(rawBody, req.method, path, req.headers);
    if (!ok) {
      this.log.warn('Rejected webhook POST on / - HTTP signature verification failed (401)');
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody.toString());
    } catch (error) {
      // The request was signed by SmartThings, so an unparseable body is anomalous - drop it.
      this.log.warn('Dropping signed webhook POST with unparseable body (400):', error);
      res.writeHead(400);
      res.end();
      return;
    }

    const lifecycleType = parsed.lifecycle || parsed.messageType;
    if (lifecycleType && KNOWN_LIFECYCLES.includes(lifecycleType)) {
      parsed.lifecycle = lifecycleType; // Normalize to "lifecycle" for handler
      this.handleSmartThingsLifecycle(parsed, res);
    } else {
      this.log.warn(`Dropping webhook POST with non-allowlisted lifecycle (lifecycle=${lifecycleType ?? 'none'}) (400)`);
      res.writeHead(400);
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
      // No challenge to echo back — ack with 200 so SmartThings doesn't treat it as a failed delivery.
      this.log.warn('Received PING lifecycle without challenge data - acknowledging');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    }
  }

  private handleConfirmation(body: any, res: http.ServerResponse): void {
    const confirmationUrl = body.confirmationData?.confirmationUrl;
    if (confirmationUrl) {
      this.log.info('Received SmartThings CONFIRMATION - hitting confirmation URL');
      // Only call https URLs, never follow redirects, and time out — limits SSRF if a forged
      // CONFIRMATION reaches this handler (always possible when verification is disabled).
      if (typeof confirmationUrl === 'string' && /^https:\/\//i.test(confirmationUrl)) {
        axios.get(confirmationUrl, { timeout: 5000, maxRedirects: 0 })
          .then(() => {
            this.log.info('Successfully confirmed SmartThings app registration');
          })
          .catch((error) => {
            this.log.error('Failed to confirm SmartThings app registration:', error);
          });
      } else {
        this.log.error('Refusing to call non-https confirmation URL from CONFIRMATION lifecycle');
      }
      const serverUrl = this.platform.config.server_url || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ targetUrl: serverUrl }));
    } else {
      // No confirmationUrl to act on — ack with 200 so SmartThings doesn't treat it as a failed delivery.
      this.log.warn('Received CONFIRMATION lifecycle without confirmationUrl - acknowledging');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
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
