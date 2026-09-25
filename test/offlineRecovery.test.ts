import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MultiServiceAccessory } from '../src/multiServiceAccessory';
import { stubLog } from './helpers';

const ONE_MINUTE = 60 * 1000;

// startPollingState/refreshStatus only read these fields, so build the accessory without running
// its constructor (which needs a live platform and SmartThings API client).
function offlineAccessory(get: (url: string) => Promise<unknown>, offlineForMs = ONE_MINUTE + 1000) {
  const accessory = Object.create(MultiServiceAccessory.prototype);
  Object.assign(accessory, {
    name: 'Test device',
    log: stubLog,
    online: false,
    giveUpTime: Date.now() - offlineForMs,
    failureCount: 5,
    commandInProgress: false,
    lastCommandCompleted: 0,
    deviceStatusTimestamp: 0,
    statusQueryInProgress: false,
    lastStatusResult: true,
    hasInitialStatus: false,
    components: [{ componentId: 'main', capabilities: ['switch'], status: {} }],
    services: [],
    statusURL: 'devices/test/status',
    healthURL: 'devices/test/health',
    axInstance: { get },
  });
  return accessory;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Run the poll loop until `done()` (or for at most `maxMs`) and collect any unhandled promise
// rejections - which Node turns into an uncaughtException that makes Homebridge shut down.
async function runPollLoop(accessory: MultiServiceAccessory, done: () => boolean = () => false, maxMs = 100): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  mock.method(Math, 'random', () => 0); // no jitter: tick every 10 ms
  const timer = accessory.startPollingState(0.01, async () => 0, { updateCharacteristic: () => undefined } as any, {} as any);
  try {
    const deadline = Date.now() + maxMs;
    while (!done() && Date.now() < deadline) {
      await sleep(5);
    }
  } finally {
    clearInterval(timer as NodeJS.Timeout);
    mock.restoreAll();
    await sleep(10); // let rejections from the last tick surface while we are still listening
    process.off('unhandledRejection', onUnhandled);
  }
  return unhandled;
}

test('a failed recovery attempt while offline does not cause an unhandled rejection', async () => {
  const get = mock.fn<(url: string) => Promise<unknown>>(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.smartthings.com')));
  const accessory = offlineAccessory(get);

  const unhandled = await runPollLoop(accessory, () => get.mock.callCount() >= 1, 2000);

  assert.ok(get.mock.callCount() >= 1, 'expected an offline recovery attempt');
  assert.deepEqual(unhandled, []);
  assert.equal(accessory.isOnline(), false);
});

test('a failed recovery attempt throttles the next one', async () => {
  const get = mock.fn<(url: string) => Promise<unknown>>(() => Promise.reject(new Error('Network Error')));
  const accessory = offlineAccessory(get);

  await runPollLoop(accessory, () => false, 150);

  assert.equal(get.mock.callCount(), 1, 'only one attempt per retry interval');
  assert.equal(accessory.isOnline(), false);
});

test('a successful status refresh brings the device back online (no /health call)', async () => {
  const status = { data: { components: { main: { switch: { switch: { value: 'on' } } } } } };
  const get = mock.fn<(url: string) => Promise<unknown>>(() => Promise.resolve(status));
  const accessory = offlineAccessory(get);

  await runPollLoop(accessory, () => accessory.isOnline(), 2000);

  assert.equal(accessory.isOnline(), true);
  assert.equal(accessory.failureCount, 0);
  assert.equal(accessory.giveUpTime, 0);
  assert.deepEqual(get.mock.calls.map(c => c.arguments[0]), ['devices/test/status']);
});

test('no recovery attempt within a minute of going offline', async () => {
  const get = mock.fn<(url: string) => Promise<unknown>>(() => Promise.resolve({ data: { components: { main: {} } } }));
  const accessory = offlineAccessory(get, 5 * 1000);

  await runPollLoop(accessory);

  assert.equal(get.mock.callCount(), 0);
  assert.equal(accessory.isOnline(), false);
});
