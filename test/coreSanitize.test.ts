import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as util from 'util';
import axios, { AxiosError, AxiosAdapter } from 'axios';
import { SmartThingsAuth } from '../src/auth/auth';
import { describeError } from '../src/auth/sanitizeError';
import { makePlatform, recordingLog, tempStorage, validTokens, writeTokenFile } from './coreHelpers';

const CLIENT_SECRET = 'super-secret-client-secret';
const REFRESH_TOKEN = 'refresh-token-that-must-not-leak';
const BASIC = Buffer.from(`client:${CLIENT_SECRET}`).toString('base64');

// Fails like a real axios request: config + a request object whose raw header block repeats Authorization.
function failingAdapter(status?: number): AxiosAdapter {
  return async (config) => {
    const request = { _header: `POST /oauth/token HTTP/1.1\r\nAuthorization: ${config.headers?.Authorization}\r\n` };
    const response = status === undefined ? undefined : {
      status, statusText: '', headers: {}, config, request,
      data: { error: 'invalid_grant', error_description: 'Invalid refresh token' },
    };
    throw new AxiosError(status ? `Request failed with status code ${status}` : 'Network Error',
      status ? 'ERR_BAD_REQUEST' : 'ERR_NETWORK', config, request, response as never);
  };
}

const originalAdapter = axios.defaults.adapter;
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

function assertClean(text: string) {
  for (const secret of [CLIENT_SECRET, REFRESH_TOKEN, BASIC, 'file-access-token']) {
    assert.ok(!text.includes(secret), `leaked ${secret} in: ${text.slice(0, 400)}`);
  }
}

for (const status of [400, undefined]) {
  test(`a failed token refresh (${status ?? 'network'}) logs and throws no credentials`, async () => {
    axios.defaults.adapter = failingAdapter(status);
    const log = recordingLog();
    const auth = new SmartThingsAuth('client', CLIENT_SECRET, log as never, { config: {} } as never, tempStorage(),
      { setAuthHandler: () => undefined } as never);

    const error = await auth.refreshTokens(REFRESH_TOKEN).then(() => null, (e: unknown) => e);

    assert.ok(error);
    assertClean(log.lines.join('\n'));
    assertClean(util.inspect(error, { depth: 6 }));
    if (status) {
      assert.match(log.lines.join('\n'), /HTTP 400.*invalid_grant.*Invalid refresh token/);
    }
  });
}

test('API errors reaching services carry no bearer token', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens());
  const { platform } = makePlatform({}, storage);
  platform.axInstance.defaults.adapter = failingAdapter(500);

  const error = await platform.axInstance.get('devices/x/status').then(() => null, (e: unknown) => e);

  assert.ok(error);
  assertClean(util.inspect(error, { depth: 6 }));
});

test('describeError keeps the useful parts', () => {
  const data = { requestId: '1', error: { code: 'Forbidden', message: 'nope' } };
  const err = new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST',
    { headers: { Authorization: 'Bearer x' } } as never, {},
    { status: 403, statusText: '', headers: {}, config: {} as never, data });
  const text = describeError(err);
  assert.match(text, /status code 403/);
  assert.match(text, /HTTP 403/);
  assert.match(text, /Forbidden nope/);
  assert.ok(!text.includes('Bearer'));
  assert.equal(describeError(undefined), 'undefined');
  assert.equal(describeError('plain'), 'plain');
});
