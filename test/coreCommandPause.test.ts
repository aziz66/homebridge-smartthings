import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MultiServiceAccessory } from '../src/multiServiceAccessory';
import { stubLog } from './helpers';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function accessoryWithPost(post: () => Promise<unknown>) {
  const accessory = Object.create(MultiServiceAccessory.prototype);
  Object.assign(accessory, {
    name: 'Test device',
    log: stubLog,
    online: true,
    failureCount: 0,
    giveUpTime: 0,
    commandInProgress: false,
    lastCommandCompleted: 0,
    commandURL: 'devices/x/commands',
    axInstance: { post },
  });
  return accessory;
}

async function pollsWithin(accessory: MultiServiceAccessory, ms: number): Promise<number> {
  const getValue = mock.fn(async () => 1);
  mock.method(Math, 'random', () => 0);
  const timer = accessory.startPollingState(0.01, getValue, { updateCharacteristic: () => undefined } as never, {} as never);
  try {
    await sleep(ms);
  } finally {
    clearInterval(timer as NodeJS.Timeout);
    mock.restoreAll();
  }
  return getValue.mock.callCount();
}

test('a successful command records its completion time', async () => {
  const accessory = accessoryWithPost(() => Promise.resolve({}));
  const before = Date.now();
  assert.equal(await accessory.sendCommand('main', 'switch', 'on'), true);
  assert.ok(accessory.lastCommandCompleted >= before);
});

test('a failed command records its completion time too', async () => {
  const accessory = accessoryWithPost(() => Promise.reject(new Error('HTTP 500')));
  const before = Date.now();
  assert.equal(await accessory.sendCommand('main', 'switch', 'on'), false);
  assert.ok(accessory.lastCommandCompleted >= before);
});

test('polling pauses right after a command so the tile does not bounce back', async () => {
  const accessory = accessoryWithPost(() => Promise.resolve({}));
  await accessory.sendCommand('main', 'switch', 'on');
  assert.equal(await pollsWithin(accessory, 80), 0);
});

test('polling runs normally when no command was sent recently', async () => {
  const accessory = accessoryWithPost(() => Promise.resolve({}));
  assert.ok(await pollsWithin(accessory, 80) > 0);
});
