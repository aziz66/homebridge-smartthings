import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import { makePlatform, stubAdapter } from './coreHelpers';

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

function device(label: string, manufacturerName?: string) {
  return {
    deviceId: DEVICE_ID,
    label,
    manufacturerName,
    components: [{ id: 'main', capabilities: [{ id: 'switch' }] }],
  };
}

test('a restored accessory gets the fresh device record and is persisted', async () => {
  const { platform, api } = makePlatform({ PollSwitchesAndLightsSeconds: 0 });
  stubAdapter(platform, () => ({ status: 200, data: {} }));
  const accessory = new PlatformAccessory('Old name', DEVICE_ID);
  accessory.context.device = { ...device('Old name'), components: [] };
  platform.configureAccessory(accessory);

  const fresh = device('New name');
  await platform.discoverDevices([fresh]);

  assert.equal(accessory.context.device, fresh);
  assert.deepEqual(api.updated, [[accessory]]);
  assert.deepEqual(api.registered, []);
});

test('a missing manufacturer name falls back to SmartThings', async () => {
  const { platform } = makePlatform({ PollSwitchesAndLightsSeconds: 0 });
  stubAdapter(platform, () => ({ status: 200, data: {} }));

  await platform.discoverDevices([device('Plug')]);

  const accessory = (platform as unknown as { accessoryObjects: { accessory: PlatformAccessory }[] }).accessoryObjects[0].accessory;
  const info = accessory.getService(hap.Service.AccessoryInformation)!;
  assert.equal(info.getCharacteristic(hap.Characteristic.Manufacturer).value, 'SmartThings');
});
