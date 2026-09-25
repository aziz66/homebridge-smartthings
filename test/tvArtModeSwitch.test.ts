import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { ArtModeSwitchService } from '../src/services/artModeSwitchService';
import { fakeAccessory, fakePlatform } from './helpers';

function createArtSwitch(getArtModeStatus: () => Promise<string>) {
  const accessory = fakeAccessory('Frame Art Mode', []);
  const calls = { status: 0 };
  const samsungWs = {
    getArtModeStatus: () => {
      calls.status++;
      return getArtModeStatus();
    },
  };
  const artSwitch = new ArtModeSwitchService(fakePlatform(), accessory, samsungWs as any, 'Frame Art Mode');
  const on = accessory.getService(hap.Service.Switch)!.getCharacteristic(hap.Characteristic.On);
  return { artSwitch, on, calls };
}

test('Art Mode onGet answers from cache without a live WebSocket round-trip', async () => {
  // A TV that never answers (e.g. powered off): the old onGet waited on this.
  const { artSwitch, on, calls } = createArtSwitch(() => new Promise<string>(() => undefined));
  try {
    const callsAfterStartup = calls.status;
    const start = Date.now();
    const value = await on.handleGetRequest();
    assert.equal(value, false);
    assert.ok(Date.now() - start < 100);
    assert.equal(calls.status, callsAfterStartup, 'onGet must not query the TV');
  } finally {
    artSwitch.stopPolling();
  }
});

test('Art Mode state is seeded from the TV at startup', async () => {
  const { artSwitch, on } = createArtSwitch(async () => 'on');
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(on.value, true);
    assert.equal(await on.handleGetRequest(), true);
  } finally {
    artSwitch.stopPolling();
  }
});
