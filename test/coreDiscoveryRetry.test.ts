import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError } from 'axios';
import { makePlatform, sleep, stubAdapter, validTokens, writeTokenFile, tempStorage } from './coreHelpers';

function classify(error: unknown): boolean {
  const { platform } = makePlatform();
  return (platform as unknown as { isNetworkError(e: unknown): boolean }).isNetworkError(error);
}

function withCode(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

function httpError(status: number): AxiosError {
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', {} as never, {},
    { status, data: {}, statusText: '', headers: {}, config: {} as never });
}

test('transport failures are retryable', () => {
  for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN',
    'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'ERR_NETWORK']) {
    assert.equal(classify(withCode(code)), true, code);
  }
  assert.equal(classify(new Error('Network Error')), true);
  assert.equal(classify(new Error('timeout of 15000ms exceeded')), true);
  // An axios request that never got a response
  assert.equal(classify(new AxiosError('whatever', undefined, {} as never, {})), true);
});

test('5xx and 429 responses are retryable, other HTTP errors are not', () => {
  assert.equal(classify(httpError(500)), true);
  assert.equal(classify(httpError(503)), true);
  assert.equal(classify(httpError(429)), true);
  assert.equal(classify(httpError(401)), false);
  assert.equal(classify(httpError(403)), false);
  assert.equal(classify(httpError(404)), false);
  assert.equal(classify(new Error('No refresh token available for automatic refresh.')), false);
  assert.equal(classify(undefined), false);
});

test('startup discovery that fails on a network error is retried in the background', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens());
  const { platform, api } = makePlatform({}, storage);
  const internals = platform as unknown as {
    delay: () => Promise<void>; rediscoveryDelayMs: number; rediscoveryTimer: NodeJS.Timeout | null;
    scheduleRediscovery: () => void;
  };
  internals.delay = async () => undefined; // skip withRetry back-off
  // Long enough that the background retry can't fire while startup is still running (which made
  // this test flaky under load); the retry is then re-armed with a short delay below.
  internals.rediscoveryDelayMs = 60 * 1000;

  let networkUp = false;
  const calls = stubAdapter(platform, (config) => {
    if (!networkUp) {
      throw new AxiosError('Network Error', 'ERR_NETWORK', config, {});
    }
    return { status: 200, data: { items: [] } };
  });

  await api.handlers.didFinishLaunching();
  assert.equal(calls.length, 3, 'three attempts during startup');
  assert.ok(internals.rediscoveryTimer, 'a background re-discovery must be scheduled');
  assert.equal(internals.rediscoveryDelayMs, 120 * 1000, 'next delay doubles');

  clearTimeout(internals.rediscoveryTimer!);
  internals.rediscoveryTimer = null;
  internals.rediscoveryDelayMs = 1;
  internals.scheduleRediscovery();
  networkUp = true;
  const deadline = Date.now() + 2000;
  while (calls.length < 4 && Date.now() < deadline) {
    await sleep(10);
  }
  await sleep(20);
  assert.equal(calls.length, 4);
  assert.equal(internals.rediscoveryTimer, null);
});

test('a non-network discovery failure is not retried in the background', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens());
  const { platform, api } = makePlatform({}, storage);
  stubAdapter(platform, () => ({ status: 403, data: {} }));

  await api.handlers.didFinishLaunching();

  assert.equal((platform as unknown as { rediscoveryTimer: unknown }).rediscoveryTimer, null);
});

test('shutdown cancels a pending background re-discovery', async () => {
  const storage = tempStorage();
  writeTokenFile(storage, validTokens());
  const { platform, api } = makePlatform({}, storage);
  const internals = platform as unknown as { delay: () => Promise<void>; rediscoveryTimer: unknown };
  internals.delay = async () => undefined;
  stubAdapter(platform, (config) => {
    throw new AxiosError('Network Error', 'ERR_NETWORK', config, {});
  });

  await api.handlers.didFinishLaunching();
  assert.ok(internals.rediscoveryTimer);
  api.handlers.shutdown();
  assert.equal(internals.rediscoveryTimer, null);
});
