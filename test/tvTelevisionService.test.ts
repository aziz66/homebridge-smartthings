import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import { TelevisionService } from '../src/services/televisionService';
import { fakeAccessory, fakePlatform } from './helpers';

const TV_CAPABILITIES = ['switch', 'samsungvd.mediaInputSource', 'custom.launchapp', 'audioVolume', 'audioMute'];

interface Poll {
  pollSeconds: number;
  getValue: () => Promise<hap.CharacteristicValue>;
  service: hap.Service;
  characteristic: { UUID: string };
}

// Stands in for MultiServiceAccessory: holds the device status and records polls.
function fakeMultiServiceAccessory(status: Record<string, any>) {
  const polls: Poll[] = [];
  const component = { componentId: 'main', capabilities: TV_CAPABILITIES, status };
  return {
    polls,
    component,
    components: [component],
    startPollingState: (pollSeconds: number, getValue: Poll['getValue'], service: hap.Service, characteristic: Poll['characteristic']) => {
      polls.push({ pollSeconds, getValue, service, characteristic });
      return { fake: 'timer' };
    },
    isOnline: () => true,
    hasCachedStatus: () => true,
    refreshStatus: async () => true,
    forceNextStatusRefresh: () => undefined,
    sendCommand: async () => true,
  };
}

function inputStatus(inputs: { id: string; name: string }[], current?: string) {
  return {
    switch: { switch: { value: 'on' } },
    'samsungvd.mediaInputSource': {
      supportedInputSourcesMap: { value: inputs },
      ...(current ? { inputSource: { value: current } } : {}),
    },
  };
}

function createTv(options: {
  config?: Record<string, unknown>;
  status?: Record<string, any>;
  capabilities?: string[];
  accessory?: PlatformAccessory;
} = {}) {
  const capabilities = options.capabilities ?? TV_CAPABILITIES;
  const accessory = options.accessory ?? fakeAccessory('Living Room TV', capabilities);
  const msa = fakeMultiServiceAccessory(options.status ?? inputStatus([]));
  const tv = new TelevisionService(fakePlatform(options.config ?? {}), accessory, 'main', capabilities,
    msa as any, 'Living Room TV', msa.component);
  const tvService = accessory.getService(hap.Service.Television)!;
  return { tv: tv as any, accessory, msa, tvService };
}

test('TV power state is polled on PollTelevisionsSeconds', async () => {
  const { msa, tvService } = createTv({ config: { PollTelevisionsSeconds: 30 } });
  assert.equal(msa.polls.length, 1);
  const poll = msa.polls[0];
  assert.equal(poll.pollSeconds, 30);
  assert.equal(poll.service, tvService);
  assert.equal(poll.characteristic.UUID, hap.Characteristic.Active.UUID);
  assert.equal(await poll.getValue(), hap.Characteristic.Active.ACTIVE);
});

test('TV polling defaults to 15s and honours PollTelevisionsSeconds: 0', () => {
  assert.equal(createTv().msa.polls[0].pollSeconds, 15);
  assert.equal(createTv({ config: { PollTelevisionsSeconds: 0 } }).msa.polls.length, 0);
});

test('TV polling is not started without the switch capability', () => {
  const { msa } = createTv({ capabilities: ['samsungvd.mediaInputSource', 'audioVolume'] });
  assert.equal(msa.polls.length, 0);
});
