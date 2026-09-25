import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { SwitchService } from '../src/services/switchService';
import { fakeAccessory, fakePlatform } from './helpers';
import { fakeMultiServiceAccessory } from './devicesHelpers';

// SwitchService receives only ['switch'] as its own capabilities; the metering capabilities live
// on the component record it is given, which is what ExposeEnergyAsOutlet must look at.
function makeSwitch(config: Record<string, unknown>, componentCapabilities: string[]) {
  const accessory = fakeAccessory('Plug', componentCapabilities);
  const msa = Object.assign(fakeMultiServiceAccessory(), {
    isTelevisionDevice: () => false,
    mainHasCapability: (c: string) => componentCapabilities.includes(c),
  });
  const component = { componentId: 'main', capabilities: componentCapabilities, status: {} };
  new SwitchService(fakePlatform(config), accessory, 'main', ['switch'], msa as never, 'Plug', component);
  return accessory;
}

test('ExposeEnergyAsOutlet publishes a metering plug as an Outlet', () => {
  const accessory = makeSwitch({ ExposeEnergyMonitoring: true, ExposeEnergyAsOutlet: true },
    ['switch', 'powerMeter', 'energyMeter']);
  assert.ok(accessory.getService(hap.Service.Outlet));
  assert.equal(accessory.getService(hap.Service.Switch), undefined);
});

test('a plug without metering stays a Switch even with ExposeEnergyAsOutlet', () => {
  const accessory = makeSwitch({ ExposeEnergyMonitoring: true, ExposeEnergyAsOutlet: true }, ['switch']);
  assert.ok(accessory.getService(hap.Service.Switch));
  assert.equal(accessory.getService(hap.Service.Outlet), undefined);
});

test('ExposeEnergyAsOutlet does nothing without ExposeEnergyMonitoring', () => {
  const accessory = makeSwitch({ ExposeEnergyAsOutlet: true }, ['switch', 'powerMeter']);
  assert.ok(accessory.getService(hap.Service.Switch));
});
