import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import { makePlatform } from './coreHelpers';

function cached(deviceId: string, uuid = deviceId): PlatformAccessory {
  const accessory = new PlatformAccessory(deviceId, uuid);
  accessory.context.device = { deviceId, label: deviceId };
  return accessory;
}

test('UnregisterAll unregisters each accessory once and forgets them', () => {
  const { platform, api } = makePlatform();
  const kept = cached('11111111-1111-1111-1111-111111111111');
  const gone = cached('22222222-2222-2222-2222-222222222222');
  platform.configureAccessory(kept);
  platform.configureAccessory(gone);

  // `gone` is both "all" and "not in the device list" - it used to be pushed twice.
  platform.unregisterDevices([{ deviceId: kept.UUID }], true);

  assert.equal(api.unregistered.length, 1);
  assert.deepEqual(api.unregistered[0], [kept, gone]);
  assert.deepEqual(platform.accessories, []);
});

test('unregistering a missing device removes it from the restored cache', () => {
  const { platform, api } = makePlatform();
  const kept = cached('11111111-1111-1111-1111-111111111111');
  const gone = cached('22222222-2222-2222-2222-222222222222');
  platform.configureAccessory(kept);
  platform.configureAccessory(gone);

  platform.unregisterDevices([{ deviceId: kept.UUID }]);

  assert.deepEqual(api.unregistered, [[gone]]);
  assert.deepEqual(platform.accessories, [kept]);
});

test('an orphaned Art Mode accessory is unregistered, a wanted one is kept', () => {
  const { platform, api } = makePlatform();
  const orphan = cached('tv-gone-artmode', hap.uuid.generate('tv-gone-artmode'));
  const wanted = cached('tv-here-artmode', hap.uuid.generate('tv-here-artmode'));
  platform.configureAccessory(orphan);
  platform.configureAccessory(wanted);
  // A discovered Frame TV with the Art Mode switch enabled
  (platform as unknown as { accessoryObjects: unknown[] }).accessoryObjects.push({
    samsungWebSocket: {},
    frameTvConfig: { enableArtModeSwitch: true },
    accessory: { context: { device: { deviceId: 'tv-here' } } },
  });

  platform.unregisterDevices([]);

  assert.deepEqual(api.unregistered, [[orphan]]);
  assert.deepEqual(platform.accessories, [wanted]);
});

test('Art Mode accessory is dropped when its switch is disabled', () => {
  const { platform, api } = makePlatform();
  const artMode = cached('tv-here-artmode', hap.uuid.generate('tv-here-artmode'));
  platform.configureAccessory(artMode);
  (platform as unknown as { accessoryObjects: unknown[] }).accessoryObjects.push({
    samsungWebSocket: {},
    frameTvConfig: { enableArtModeSwitch: false },
    accessory: { context: { device: { deviceId: 'tv-here' } } },
  });

  platform.unregisterDevices([]);

  assert.deepEqual(api.unregistered, [[artMode]]);
});
