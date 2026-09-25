import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { WebhookServer } from '../src/webhook/webhookServer';
import { SignatureVerifier } from '../src/webhook/signatureVerifier';
import { TokenManager } from '../src/auth/tokenManager';
import { recordingLog, sleep, tempStorage, validTokens, writeTokenFile } from './coreHelpers';

const APP_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const APP_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const LOC_A = 'cccccccc-1111-2222-3333-444444444444';

function fakeRes() {
  const res = {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(body?: string) {
      res.body = body ?? '';
      res.writableEnded = true;
    },
  };
  return res;
}

function server(stored: Record<string, unknown> = {}) {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens(stored));
  const log = recordingLog();
  const tokenManager = new TokenManager(log as never, storage, () => undefined, (async () => ({})) as never, {} as never);
  const platform = { config: {}, auth: { tokenManager } };
  const ws = new WebhookServer(platform as never, log as never);
  const events: unknown[] = [];
  ws.addEventHandler(e => events.push(e));
  const internals = ws as unknown as {
    handleLegacyPost(body: string, res: unknown): void;
    handleSmartThingsLifecycle(body: unknown, res: unknown, verified: boolean): void;
  };
  return { ws, internals, tokenManager, events, log };
}

const install = (installedAppId: unknown, locationId: unknown = LOC_A) =>
  ({ lifecycle: 'INSTALL', installData: { installedApp: { installedAppId, locationId } } });

const originalAdapter = axios.defaults.adapter;
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

test('a bare device event outside a lifecycle envelope is not dispatched', () => {
  const { internals, events } = server();
  const res = fakeRes();
  internals.handleLegacyPost(JSON.stringify({ deviceId: 'd', componentId: 'main', capability: 'lock', attribute: 'lock', value: 'unlocked' }), res);
  assert.deepEqual(events, []);
  assert.equal(res.status, 200);
});

test('device events inside an EVENT lifecycle are still dispatched', () => {
  const { internals, events } = server();
  const res = fakeRes();
  internals.handleLegacyPost(JSON.stringify({
    lifecycle: 'EVENT',
    eventData: { events: [{ eventType: 'DEVICE_EVENT', deviceEvent: { deviceId: 'd', componentId: 'main', capability: 'switch', attribute: 'switch', value: 'on' } }] },
  }), res);
  assert.equal(events.length, 1);
  assert.equal(res.status, 200);
});

test('lifecycle IDs that are not UUIDs are never stored', async () => {
  const { internals, tokenManager } = server();
  internals.handleSmartThingsLifecycle(install('../../locations/evil', { nested: true }), fakeRes(), true);
  await sleep(5);
  assert.equal(tokenManager.getInstalledAppId(), null);
  assert.equal(tokenManager.getLocationId(), null);
});

test('an unverified lifecycle event may fill in a missing ID', async () => {
  const { internals, tokenManager } = server();
  internals.handleLegacyPost(JSON.stringify(install(APP_A)), fakeRes());
  await sleep(5);
  assert.equal(tokenManager.getInstalledAppId(), APP_A);
  assert.equal(tokenManager.getLocationId(), LOC_A);
});

test('an unverified lifecycle event cannot overwrite a stored ID', async () => {
  const { internals, tokenManager } = server({ installed_app_id: APP_A });
  internals.handleLegacyPost(JSON.stringify(install(APP_B)), fakeRes());
  internals.handleLegacyPost(JSON.stringify({ lifecycle: 'EVENT', eventData: { installedApp: { installedAppId: APP_B } } }), fakeRes());
  await sleep(5);
  assert.equal(tokenManager.getInstalledAppId(), APP_A);
});

test('a signature-verified lifecycle event can update a stored ID', async () => {
  const { internals, tokenManager } = server({ installed_app_id: APP_A });
  internals.handleSmartThingsLifecycle(install(APP_B), fakeRes(), true);
  await sleep(5);
  assert.equal(tokenManager.getInstalledAppId(), APP_B);
});

test('stored IDs that are not UUIDs are ignored', () => {
  const { tokenManager } = server({ installed_app_id: 'x/../../y', location_id: 42 });
  assert.equal(tokenManager.getInstalledAppId(), null);
  assert.equal(tokenManager.getLocationId(), null);
});

test('confirmation URLs are only called on smartthings.com hosts', () => {
  const ok = WebhookServer.isSmartThingsConfirmationUrl;
  assert.equal(ok('https://api.smartthings.com/apps/123/confirm-registration?token=abc'), true);
  assert.equal(ok('https://API.SmartThings.com/x'), true);
  assert.equal(ok('https://eu.smartthings.com/x'), true);
  assert.equal(ok('http://api.smartthings.com/x'), false);
  assert.equal(ok('https://api.smartthings.com@evil.example/x'), false);
  assert.equal(ok('https://api.smartthings.com.evil.example/x'), false);
  assert.equal(ok('https://evilsmartthings.com/x'), false);
  assert.equal(ok('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(ok('not a url'), false);
  assert.equal(ok(undefined), false);
});

test('a CONFIRMATION pointing elsewhere makes no outbound request', async () => {
  const requested: unknown[] = [];
  axios.defaults.adapter = async (config) => {
    requested.push(config.url);
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  const { internals } = server();
  const res = fakeRes();
  internals.handleSmartThingsLifecycle({ lifecycle: 'CONFIRMATION', confirmationData: { confirmationUrl: 'https://evil.example/hook' } }, res, false);
  internals.handleSmartThingsLifecycle({ lifecycle: 'CONFIRMATION',
    confirmationData: { confirmationUrl: 'https://api.smartthings.com/apps/1/confirm' } }, fakeRes(), false);
  await sleep(10);
  assert.deepEqual(requested, ['https://api.smartthings.com/apps/1/confirm']);
  assert.equal(res.status, 200);
});

test('the negative certificate cache is bounded', async () => {
  const verifier = new SignatureVerifier(recordingLog() as never);
  const internals = verifier as unknown as {
    fetchCertificate(keyId: string): Promise<string | null>;
    getCertificate(keyId: string): Promise<string | null>;
    negativeCache: Map<string, number>;
  };
  internals.fetchCertificate = async () => null;
  for (let i = 0; i < 400; i++) {
    await internals.getCertificate(`/key/${i}`);
  }
  assert.ok(internals.negativeCache.size <= 256, `size ${internals.negativeCache.size}`);
  assert.ok(internals.negativeCache.has('/key/399'));
});
