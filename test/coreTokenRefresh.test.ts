import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError } from 'axios';
import { TokenManager, isAuthRejection } from '../src/auth/tokenManager';
import { SmartThingsAuth } from '../src/auth/auth';
import { makePlatform, recordingLog, sleep, stubAdapter, tempStorage, validTokens, writeTokenFile } from './coreHelpers';

function httpError(status: number, data: unknown = {}): AxiosError {
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', {} as never, {},
    { status, data, statusText: '', headers: {}, config: {} as never });
}

function expiringManager(refresh: (rt: string) => Promise<Record<string, unknown>>) {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens({ expires_at: Date.now() + 60 * 1000 })); // inside the refresh window
  let authFlows = 0;
  const tm = new TokenManager(recordingLog() as never, storage, () => {
    authFlows++;
  }, refresh as never, {} as never);
  const check = () => (tm as unknown as { checkAndRefreshTokens(): Promise<void> }).checkAndRefreshTokens();
  return { tm, check, authFlows: () => authFlows };
}

test('concurrent refreshes share one token request', async () => {
  let calls = 0;
  const { tm } = expiringManager(async (rt) => {
    calls++;
    assert.equal(rt, 'file-refresh-token');
    await sleep(20);
    return { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 86400 };
  });

  await Promise.all([tm.refreshAccessToken(), tm.refreshAccessToken(), tm.refreshAccessToken()]);

  assert.equal(calls, 1);
  assert.equal(tm.getRefreshToken(), 'new-rt');
});

test('a 401 during a monitor refresh reuses the in-flight refresh', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens({ access_token: 'old-at' }));
  const { platform } = makePlatform({}, storage);
  let refreshes = 0;
  (platform.auth.tokenManager as unknown as { refreshTokenApiCallback: unknown }).refreshTokenApiCallback = async () => {
    refreshes++;
    await sleep(30);
    return { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 86400 };
  };
  stubAdapter(platform, (config) =>
    config.headers?.Authorization === 'Bearer new-at' ? { status: 200, data: { ok: true } } : { status: 401, data: {} });

  const monitor = platform.auth.tokenManager.refreshAccessToken();
  const [res] = await Promise.all([platform.axInstance.get('devices'), monitor]);

  assert.equal(refreshes, 1);
  assert.deepEqual(res.data, { ok: true });
});

test('the monitor does not prompt re-authorization on a network failure', async () => {
  const { check, authFlows } = expiringManager(async () => {
    throw Object.assign(new Error('getaddrinfo EAI_AGAIN api.smartthings.com'), { code: 'EAI_AGAIN' });
  });
  await check();
  assert.equal(authFlows(), 0);
});

test('the monitor prompts re-authorization at most once per 10 minutes', async () => {
  const { check, authFlows } = expiringManager(async () => {
    throw httpError(401, { error: 'invalid_grant' });
  });
  await check();
  await check();
  await check();
  assert.equal(authFlows(), 1);
});

test('auth rejections vs transient failures', () => {
  assert.equal(isAuthRejection(httpError(400, { error: 'invalid_grant' })), true);
  assert.equal(isAuthRejection(httpError(401)), true);
  assert.equal(isAuthRejection(httpError(429)), false);
  assert.equal(isAuthRejection(httpError(503)), false);
  assert.equal(isAuthRejection(new Error('Network Error')), false);
});

test('the OAuth state stays stable until it is used', () => {
  const log = recordingLog();
  const platform = { config: { server_url: 'https://hb.example.test' } };
  const auth = new SmartThingsAuth('client', 'secret', log as never, platform as never, tempStorage(),
    { setAuthHandler: () => undefined } as never);

  auth.startAuthFlow();
  const first = (auth as unknown as { state: string }).state;
  auth.startAuthFlow();
  assert.equal((auth as unknown as { state: string }).state, first);
  const urls = log.lines.filter(l => l.startsWith('https://api.smartthings.com/oauth/authorize'));
  assert.equal(urls.length, 2);
  assert.equal(urls[0], urls[1]);
});

test('an incomplete or stale OAuth callback gets 400, not 500', async () => {
  const log = recordingLog();
  const platform = { config: { server_url: 'https://hb.example.test' } };
  const auth = new SmartThingsAuth('client', 'secret', log as never, platform as never, tempStorage(),
    { setAuthHandler: () => undefined } as never);
  auth.startAuthFlow();
  for (const query of [{}, { code: 'abc' }, { code: 'abc', state: 'not-the-state' }]) {
    const res = { status: 0, writeHead(status: number) {
      res.status = status; return res;
    }, end: () => undefined };
    await auth.handleOAuthCallback(query, res as never);
    assert.equal(res.status, 400, JSON.stringify(query));
  }
});
