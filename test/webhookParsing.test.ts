import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { WebhookServer, parseRequestTarget } from '../src/webhook/webhookServer';
import { TokenManager } from '../src/auth/tokenManager';
import { recordingLog, tempStorage, validTokens, writeTokenFile } from './coreHelpers';

test('malformed request targets are rejected instead of throwing', () => {
  assert.equal(parseRequestTarget('http://[::1'), null);
  assert.doesNotThrow(() => parseRequestTarget('http://xn--/')); // rejected or parsed depending on the Node version
  const callback = parseRequestTarget('/oauth/callback?code=x&state=y');
  assert.equal(callback?.pathname, '/oauth/callback');
  assert.deepEqual(callback?.query, { code: 'x', state: 'y' });
  assert.equal(parseRequestTarget(undefined)?.pathname, '/');
  assert.equal(parseRequestTarget('/?lifecycle=x')?.pathname, '/');
});

// A single malformed request line used to throw inside the request handler: an
// uncaughtException that stops Homebridge. It must now get a 400 and the server keeps serving.
test('the webhook server answers a malformed request with 400 and keeps running', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens());
  const log = recordingLog();
  const tokenManager = new TokenManager(log as never, storage, () => undefined, (async () => ({})) as never, {} as never);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const ws = new WebhookServer({ config: { webhook_port: port, server_url: 'http://example.test' }, auth: { tokenManager } } as never,
    log as never);
  const server = (ws as unknown as { server: import('node:http').Server }).server;
  await new Promise<void>(resolve => (server.listening ? resolve() : server.once('listening', () => resolve())));

  const send = (raw: string) => new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
    let data = '';
    socket.on('data', chunk => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  try {
    const bad = await send('POST http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(bad, /^HTTP\/1\.1 400/);
    const ok = await send('GET /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(ok, /^HTTP\/1\.1 404/);
  } finally {
    server.close();
  }
});
