import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiServiceAccessory } from '../src/multiServiceAccessory';
import { BaseService } from '../src/services/baseService';
import { stubLog } from './helpers';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const STATUS = { data: { components: { main: {} } } };

function accessory(overrides: Record<string, unknown> = {}) {
  const acc = Object.create(MultiServiceAccessory.prototype);
  Object.assign(acc, {
    name: 'Test device',
    log: stubLog,
    online: true,
    giveUpTime: 0,
    failureCount: 0,
    commandInProgress: false,
    lastCommandCompleted: 0,
    deviceStatusTimestamp: 0,
    statusQueryInProgress: false,
    lastStatusResult: true,
    hasInitialStatus: false,
    components: [{ componentId: 'main', capabilities: ['switch'], status: {} }],
    services: [],
    statusURL: 'devices/test/status',
    commandURL: 'devices/test/commands',
    axInstance: { get: () => Promise.resolve(STATUS), post: () => Promise.resolve({}) },
    ...overrides,
  });
  return acc;
}

async function refreshFails(acc: MultiServiceAccessory, times: number) {
  for (let i = 0; i < times; i++) {
    acc.forceNextStatusRefresh();
    assert.equal(await acc.refreshStatus(), false);
  }
}

test('five consecutive failed refreshes spanning a minute take the device offline', async () => {
  const acc = accessory({ axInstance: { get: () => Promise.reject(new Error('Network Error')) } });
  await refreshFails(acc, 4);
  assert.equal(acc.isOnline(), true);
  await refreshFails(acc, 1);
  assert.equal(acc.isOnline(), true, 'a short burst of failures does not mark the device offline');
  (acc as unknown as { firstFailureAt: number }).firstFailureAt = Date.now() - 61 * 1000;
  await refreshFails(acc, 1);
  assert.equal(acc.isOnline(), false);
  assert.ok(acc.giveUpTime > 0);
});

test('finding the device offline starts a recovery probe within seconds, not a minute', async () => {
  let calls = 0;
  const acc = accessory({
    online: false, failureCount: 5, giveUpTime: Date.now() - 11 * 1000,
    axInstance: { get: () => {
      calls++; return Promise.resolve(STATUS);
    } },
  });
  assert.equal(acc.isOnline(), false);          // this call starts the probe
  await sleep(10);
  assert.equal(calls, 1);
  assert.equal(acc.isOnline(), true);           // the probe succeeded
});

test('a successful refresh resets the consecutive failure count', async () => {
  let fail = true;
  const acc = accessory({ axInstance: { get: () => fail ? Promise.reject(new Error('Network Error')) : Promise.resolve(STATUS) } });
  await refreshFails(acc, 4);
  fail = false;
  acc.forceNextStatusRefresh();
  assert.equal(await acc.refreshStatus(), true);
  assert.equal(acc.failureCount, 0);
  fail = true;
  await refreshFails(acc, 4);
  assert.equal(acc.isOnline(), true, 'failures are only counted while consecutive');
});

test('a successful command brings an offline device back online', async () => {
  const acc = accessory({ online: false, failureCount: 7, giveUpTime: Date.now() });
  assert.equal(await acc.sendCommand('main', 'switch', 'on'), true);
  assert.equal(acc.isOnline(), true);
  assert.equal(acc.failureCount, 0);
});

test('a webhook event brings an offline device back online', () => {
  const acc = accessory({ online: false, failureCount: 7, giveUpTime: Date.now() });
  acc.processEvent({ deviceId: 'x', componentId: 'main', capability: 'switch', attribute: 'switch', value: 'on' });
  assert.equal(acc.isOnline(), true);
});

test('with polling disabled, a HomeKit read of an offline device triggers a throttled recovery', async () => {
  let gets = 0;
  const acc = accessory({
    online: false, failureCount: 5, giveUpTime: Date.now() - 2 * 60 * 1000,
    axInstance: { get: () => {
      gets++;
      return Promise.resolve(STATUS);
    } },
  });
  const platform = { log: stubLog, Service: { Switch: class {} } } as never;
  const service = new BaseService(platform, {} as never, 'main', ['switch'], acc, 'Test device', {});

  assert.equal(await (service as unknown as { getStatus(): Promise<boolean> }).getStatus(), false);
  await sleep(20);
  assert.equal(gets, 1);
  assert.equal(acc.isOnline(), true);
});

test('recovery attempts are throttled', async () => {
  let gets = 0;
  const acc = accessory({
    online: false, failureCount: 5, giveUpTime: Date.now() - 2 * 60 * 1000,
    axInstance: { get: () => {
      gets++;
      return Promise.reject(new Error('Network Error'));
    } },
  });
  acc.attemptOfflineRecovery();
  await sleep(10);
  acc.attemptOfflineRecovery();
  acc.attemptOfflineRecovery();
  await sleep(10);
  assert.equal(gets, 1);
  assert.equal(acc.isOnline(), false);
});

test('a failed status request is not retried by every poller within 5 seconds', async () => {
  let calls = 0;
  const acc = accessory({ axInstance: { get: () => {
    calls++; return Promise.reject(new Error('Network Error'));
  } } });
  assert.equal(await acc.refreshStatus(), false);
  assert.equal(await acc.refreshStatus(), false);   // another poller, same tick
  assert.equal(await acc.refreshStatus(), false);
  assert.equal(calls, 1);
  assert.equal(acc.failureCount, 1, 'only real requests count as failures');
});

test('while SmartThings is rate limiting, status refreshes serve the cache without a request', async () => {
  let calls = 0;
  const acc = accessory({
    hasInitialStatus: true,
    platform: { isRateLimited: () => true },
    axInstance: { get: () => {
      calls++; return Promise.resolve(STATUS);
    } },
  });
  assert.equal(await acc.refreshStatus(), true);
  assert.equal(calls, 0);
});
