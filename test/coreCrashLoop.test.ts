import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { makePlatform, stubAdapter, tempStorage, validTokens, writeTokenFile } from './coreHelpers';

function writeCrashLog(storage: string, count: number) {
  const entries = Array.from({ length: count }, () => ({ timestamp: Date.now(), errorType: 'API_INIT_FAILURE' }));
  fs.writeFileSync(path.join(storage, 'crash_loop_log.json'), JSON.stringify(entries));
}

function readCrashLog(storage: string): unknown[] {
  return JSON.parse(fs.readFileSync(path.join(storage, 'crash_loop_log.json'), 'utf8'));
}

test('a detected crash loop keeps the stored tokens and startup continues', async () => {
  const storage = tempStorage();
  const tokenFile = writeTokenFile(storage, validTokens());
  writeCrashLog(storage, 6);
  const { platform, api } = makePlatform({}, storage);
  const calls = stubAdapter(platform, () => ({ status: 200, data: { items: [] } }));

  await api.handlers.didFinishLaunching();

  assert.ok(fs.existsSync(tokenFile), 'token file must survive crash-loop recovery');
  assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refresh_token, 'file-refresh-token');
  assert.equal(platform.auth.getAccessToken(), 'file-access-token');
  assert.ok(calls.some(c => c.url === 'devices'), 'device discovery should still run');
  assert.deepEqual(readCrashLog(storage), []);
});

test('a successful discovery resets the crash log', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens());
  writeCrashLog(storage, 2);
  const { platform, api } = makePlatform({}, storage);
  stubAdapter(platform, () => ({ status: 200, data: { items: [] } }));

  await api.handlers.didFinishLaunching();

  assert.deepEqual(readCrashLog(storage), []);
});

test('a failed discovery is recorded once, not twice', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens());
  const { platform, api } = makePlatform({}, storage);
  stubAdapter(platform, () => ({ status: 403, data: {} }));

  await api.handlers.didFinishLaunching();

  assert.equal(readCrashLog(storage).length, 1);
});
