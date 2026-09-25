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
    commands: [] as unknown[][],
    async sendCommand(...args: unknown[]) {
      this.commands.push(args);
      return true;
    },
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

const identifierOf = (service: hap.Service) => service.getCharacteristic(hap.Characteristic.Identifier).value;
const inputSources = (accessory: PlatformAccessory) => accessory.services.filter(s => s.UUID === hap.Service.InputSource.UUID);
const NETFLIX = '3201907018807';

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

test('active input matches the HomeKit identifier after the TV input list changes', async () => {
  const { tv, msa, tvService, accessory } = createTv({
    config: { tvApps: [NETFLIX] },
    status: inputStatus([{ id: 'HDMI2', name: 'Console' }, { id: 'HDMI1', name: 'Apple TV' }]),
  });
  await tv.registerInputSourceCapability();

  // The TV now reports a new input in the middle of its list, and is showing it.
  msa.component.status = inputStatus(
    [{ id: 'HDMI2', name: 'Console' }, { id: 'dtv', name: 'Live TV' }, { id: 'HDMI1', name: 'Apple TV' }], 'dtv');
  await tv.checkAndUpdateInputSources();

  const byId = (id: string) => inputSources(accessory).find(s => s.name === id)!;
  const identifiers = inputSources(accessory).map(identifierOf).sort();
  assert.deepEqual(identifiers, [1, 2, 3, 4]);

  // Reading the active input resolves to the dtv service's identifier.
  assert.equal(await tv.getActiveIdentifier(), identifierOf(byId('dtv')));

  // A webhook for an input / app launch lands on the matching service.
  tv.processEvent({ capability: 'samsungvd.mediaInputSource', attribute: 'inputSource', value: 'HDMI1' });
  assert.equal(tvService.getCharacteristic(hap.Characteristic.ActiveIdentifier).value, identifierOf(byId('HDMI1')));
  tv.processEvent({ capability: 'custom.launchapp', attribute: 'launchApp', value: NETFLIX });
  assert.equal(tvService.getCharacteristic(hap.Characteristic.ActiveIdentifier).value, identifierOf(byId(NETFLIX)));

  // Selecting an identifier in HomeKit switches to that service's input.
  await tv.setActiveIdentifier(identifierOf(byId('dtv')));
  assert.deepEqual(msa.commands[msa.commands.length - 1], ['main', 'samsungvd.mediaInputSource', 'setInputSource', ['dtv']]);
});

test('an unchanged input list with duplicate IDs does not trigger a rebuild on the first poll', async () => {
  const inputs = [{ id: 'HDMI2', name: 'HDMI 2' }, { id: 'HDMI1', name: 'HDMI 1' }, { id: 'HDMI1', name: 'PlayStation 5' }];
  const { tv, msa } = createTv({ status: inputStatus(inputs) });
  await tv.registerInputSourceCapability();
  let rebuilt = false;
  tv.updateExistingInputSources = async () => {
    rebuilt = true;
  };
  await tv.checkAndUpdateInputSources();
  assert.equal(rebuilt, false);
  // The device status array is left in the TV's order.
  assert.deepEqual(msa.component.status['samsungvd.mediaInputSource'].supportedInputSourcesMap.value, inputs);
});
