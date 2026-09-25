import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IKHomeBridgeHomebridgePlatform } from '../src/platform';
import { makePlatform, stubAdapter } from './coreHelpers';

test('Retry-After parsing: seconds, HTTP date, cap and default', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(IKHomeBridgeHomebridgePlatform.retryAfterMs('2', now), 2000);
  assert.equal(IKHomeBridgeHomebridgePlatform.retryAfterMs('0', now), 0);
  assert.equal(IKHomeBridgeHomebridgePlatform.retryAfterMs('3600', now), 30000);
  assert.equal(IKHomeBridgeHomebridgePlatform.retryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now), 10000);
  assert.equal(IKHomeBridgeHomebridgePlatform.retryAfterMs('Wed, 31 Dec 2025 23:00:00 GMT', now), 0);
  assert.equal(IKHomeBridgeHomebridgePlatform.retryAfterMs(undefined, now), 5000);
  assert.equal(IKHomeBridgeHomebridgePlatform.retryAfterMs('soon', now), 5000);
});

test('a 429 is retried once after Retry-After and does not trigger a token refresh', async () => {
  const { platform } = makePlatform();
  let refreshes = 0;
  (platform.auth.tokenManager as unknown as { refreshTokenApiCallback: unknown }).refreshTokenApiCallback = async () => {
    refreshes++;
    return {};
  };
  let attempts = 0;
  const calls = stubAdapter(platform, () => {
    attempts++;
    return attempts === 1 ? { status: 429, headers: { 'retry-after': '0' } } : { status: 200, data: { ok: true } };
  });

  const res = await platform.axInstance.get('devices');

  assert.deepEqual(res.data, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(refreshes, 0);
});

test('a second consecutive 429 is returned to the caller', async () => {
  const { platform } = makePlatform();
  const calls = stubAdapter(platform, () => ({ status: 429, headers: { 'retry-after': '0' } }));

  await assert.rejects(platform.axInstance.get('devices'), (e: { response?: { status: number } }) => e.response?.status === 429);
  assert.equal(calls.length, 2);
});

test('a rate-limited command is not retried after a long wait (HomeKit has given up by then)', async () => {
  const { platform } = makePlatform();
  const calls = stubAdapter(platform, () => ({ status: 429, headers: { 'retry-after': '20' } }));

  await assert.rejects(platform.axInstance.post('devices/x/commands', {}), (e: { response?: { status: number } }) => e.response?.status === 429);
  assert.equal(calls.length, 1);
});

test('a rate-limited command is retried after a short wait', async () => {
  const { platform } = makePlatform();
  let n = 0;
  const calls = stubAdapter(platform, () => (n++ === 0 ? { status: 429, headers: { 'retry-after': '0' } } : { status: 200 }));

  await assert.doesNotReject(platform.axInstance.post('devices/x/commands', {}));
  assert.equal(calls.length, 2);
});
