import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TokenManager } from '../src/auth/tokenManager';
import { recordingLog, tempStorage, validTokens, writeTokenFile } from './coreHelpers';

const DAY = 24 * 60 * 60 * 1000;

function manager(storage = tempStorage(), config: Record<string, unknown> = {},
  refresh: (rt: string) => Promise<Record<string, unknown>> = async () => ({})) {
  let authFlows = 0;
  const tm = new TokenManager(recordingLog() as never, storage, () => {
    authFlows++;
  }, refresh as never, config as never);
  return { tm, storage, authFlows: () => authFlows };
}

function stored(tm: TokenManager) {
  return (tm as unknown as { tokenData: Record<string, number | string> }).tokenData;
}

test('a partial update (location / installed app id) keeps both expiries', async () => {
  const storage = tempStorage();
  const tokens = validTokens({ expires_at: Date.now() + 3 * 60 * 60 * 1000, refresh_token_expires_at: Date.now() + 10 * DAY });
  writeTokenFile(storage, tokens);
  const { tm } = manager(storage);

  await tm.updateTokens({ location_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  await tm.updateTokens({ installed_app_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });

  assert.equal(stored(tm).expires_at, tokens.expires_at);
  assert.equal(stored(tm).refresh_token_expires_at, tokens.refresh_token_expires_at);
  assert.equal(tm.isTokenValid(), true);
  assert.equal(tm.getAccessToken(), 'file-access-token');
});

test('a refresh response moves both expiries', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens({ expires_at: Date.now() + 1000, refresh_token_expires_at: Date.now() + DAY }));
  const { tm } = manager(storage);
  const before = Date.now();

  await tm.updateTokens({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 86400 });

  assert.ok((stored(tm).expires_at as number) >= before + 86400 * 1000);
  assert.ok((stored(tm).refresh_token_expires_at as number) >= before + 29 * DAY);
});

const WIZARD = { oauth_access_token: 'wizard-at-1', oauth_refresh_token: 'wizard-rt-1', oauth_expires_in: 86400 };

function readFile(storage: string) {
  return JSON.parse(fs.readFileSync(path.join(storage, 'smartthings_tokens.json'), 'utf8'));
}

test('tokens seeded from the config record which config refresh token they came from', () => {
  const { tm, storage } = manager(tempStorage(), WIZARD);
  const file = readFile(storage);
  assert.equal(tm.getRefreshToken(), 'wizard-rt-1');
  assert.match(file.seeded_from_config_refresh_token_sha256, /^[0-9a-f]{64}$/);
});

test('rotated tokens in the file win while the config still holds the seed token', async () => {
  const storage = tempStorage();
  const first = manager(storage, WIZARD);
  await first.tm.updateTokens({ access_token: 'rotated-at', refresh_token: 'rotated-rt', expires_in: 86400 });

  const { tm } = manager(storage, WIZARD);
  assert.equal(tm.getRefreshToken(), 'rotated-rt');
  assert.equal(tm.getAccessToken(), 'rotated-at');
});

test('new wizard tokens in the config win over a file seeded from older ones', async () => {
  const storage = tempStorage();
  const first = manager(storage, WIZARD);
  // e.g. the still-running plugin re-created the file with old tokens after the wizard cleared it
  await first.tm.updateTokens({ access_token: 'rotated-at', refresh_token: 'rotated-rt', expires_in: 86400 });

  const rerun = { oauth_access_token: 'wizard-at-2', oauth_refresh_token: 'wizard-rt-2', oauth_expires_in: 86400 };
  const { tm } = manager(storage, rerun);
  assert.equal(tm.getRefreshToken(), 'wizard-rt-2');
  assert.equal(tm.getAccessToken(), 'wizard-at-2');
  // persisted with the new seed, so later refreshes win again on the next start
  await tm.updateTokens({ access_token: 'rotated-at-2', refresh_token: 'rotated-rt-2', expires_in: 86400 });
  assert.equal(manager(storage, rerun).tm.getRefreshToken(), 'rotated-rt-2');
});

test('a token file without a seed (older versions, callback flow) still wins', () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens());
  const { tm } = manager(storage, WIZARD);
  assert.equal(tm.getRefreshToken(), 'file-refresh-token');
});

test('the token file is written owner-only', { skip: process.platform === 'win32' }, async () => {
  const storage = tempStorage();
  const file = writeTokenFile(storage, validTokens());
  fs.chmodSync(file, 0o644);
  const { tm } = manager(storage);
  await tm.updateTokens({ location_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
