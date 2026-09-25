import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MultiServiceAccessory } from '../src/multiServiceAccessory';
import { stubLog } from './helpers';

const TEN_MINUTES = 10 * 60 * 1000;

// startPollingState only reads these fields, so build the accessory without running its
// constructor (which needs a live platform and SmartThings API client).
function offlineAccessory(get: () => Promise<unknown>, offlineForMs = TEN_MINUTES + 60 * 1000) {
  const accessory = Object.create(MultiServiceAccessory.prototype);
  Object.assign(accessory, {
    name: 'Test device',
    log: stubLog,
    online: false,
    giveUpTime: Date.now() - offlineForMs,
    failureCount: 5,
    commandInProgress: false,
    lastCommandCompleted: 0,
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

test('a failed health check while offline does not cause an unhandled rejection', async () => {
  const get = mock.fn(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.smartthings.com')));
  const accessory = offlineAccessory(get);

  const unhandled = await runPollLoop(accessory, () => get.mock.callCount() >= 2, 2000);

  assert.ok(get.mock.callCount() >= 2, 'expected the offline recovery health check to run');
  assert.deepEqual(unhandled, []);
  assert.equal(accessory.isOnline(), false);
});

test('an ONLINE health check brings the device back online', async () => {
  const accessory = offlineAccessory(() => Promise.resolve({ data: { state: 'ONLINE' } }));

  await runPollLoop(accessory, () => accessory.isOnline(), 2000);

  assert.equal(accessory.isOnline(), true);
});

test('no health check before the device has been offline for 10 minutes', async () => {
  const get = mock.fn(() => Promise.resolve({ data: { state: 'ONLINE' } }));
  const accessory = offlineAccessory(get, 60 * 1000);

  await runPollLoop(accessory);

  assert.equal(get.mock.callCount(), 0);
  assert.equal(accessory.isOnline(), false);
});
