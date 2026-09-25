import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiServiceAccessory } from '../src/multiServiceAccessory';
import { stubLog } from './helpers';
import { makePlatform } from './coreHelpers';

test('the SmartThings API client has a request timeout and a default base URL', () => {
  const { platform } = makePlatform();
  assert.equal(platform.axInstance.defaults.timeout, 15000);
  assert.equal(platform.axInstance.defaults.baseURL, 'https://api.smartthings.com/v1/');
  assert.equal((platform.axInstance.defaults.headers as Record<string, unknown>).Authorization, undefined);
});

test('a configured BaseURL is still honoured', () => {
  const { platform } = makePlatform({ BaseURL: 'https://example.test/v1/' });
  assert.equal(platform.axInstance.defaults.baseURL, 'https://example.test/v1/');
});

test('a wedged command does not block later commands forever', async () => {
  const posts: string[] = [];
  const accessory = Object.create(MultiServiceAccessory.prototype);
  Object.assign(accessory, {
    name: 'Wedged device',
    log: stubLog,
    online: true,
    commandInProgress: true, // a previous command never finished
    lastCommandCompleted: 0,
    waitForTimeoutMs: 300,
    commandURL: 'devices/x/commands',
    axInstance: { post: (url: string) => {
      posts.push(url);
      return Promise.resolve({});
    } },
  });

  const ok = await accessory.sendCommand('main', 'switch', 'on');

  assert.equal(ok, true);
  assert.deepEqual(posts, ['devices/x/commands']);
  assert.equal(accessory.commandInProgress, false);
});
