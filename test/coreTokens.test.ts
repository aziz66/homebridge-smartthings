import { test } from 'node:test';
import assert from 'node:assert/strict';
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
