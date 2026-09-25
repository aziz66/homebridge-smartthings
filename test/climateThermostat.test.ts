import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { ThermostatService } from '../src/services/thermostatService';
import { FanSpeedService } from '../src/services/fanSpeedService';
import { FanSwitchLevelService } from '../src/services/fanSwitchLevelService';
import { collectUnhandledRejections, createClimateService, settleWithin } from './climateHelpers';

const THERMOSTAT_CAPS = ['temperatureMeasurement', 'thermostatMode', 'thermostatHeatingSetpoint', 'thermostatCoolingSetpoint'];

test('thermostat: a failed initial status does not raise an unhandled rejection at boot', async () => {
  const rejections = await collectUnhandledRejections(() => {
    createClimateService(ThermostatService, THERMOSTAT_CAPS, {}, { cached: false, refreshResult: false });
  });
  assert.deepEqual(rejections, []);
});

test('thermostat: a null temperature rejects the read instead of throwing inside .then', async () => {
  const status = {
    thermostatMode: { thermostatMode: { value: 'heat' } },
    temperatureMeasurement: { temperature: { value: null, unit: 'C' } },
  };
  const rejections = await collectUnhandledRejections(async () => {
    const { service } = createClimateService(ThermostatService, THERMOSTAT_CAPS, status);
    await assert.rejects(settleWithin(service.getCurrentTemperature()), hap.HapStatusError);
  });
  assert.deepEqual(rejections, []);
});

test('thermostat: a status without temperatureMeasurement rejects the read, no unhandled rejection', async () => {
  const status = { thermostatMode: { thermostatMode: { value: 'heat' } } };
  const rejections = await collectUnhandledRejections(async () => {
    const { service } = createClimateService(ThermostatService, THERMOSTAT_CAPS, status);
    await assert.rejects(settleWithin(service.getCurrentTemperature()), hap.HapStatusError);
  });
  assert.deepEqual(rejections, []);
});

test('thermostat: a missing setpoint rejects with a HAP error rather than a TypeError', async () => {
  const status = {
    thermostatMode: { thermostatMode: { value: 'heat' } },
    temperatureMeasurement: { temperature: { value: 21, unit: 'C' } },
  };
  const { service } = createClimateService(ThermostatService, THERMOSTAT_CAPS, status);
  await assert.rejects(settleWithin(service.getTargetTemperature()), hap.HapStatusError);
});

test('thermostat: Fahrenheit setpoints are sent as whole degrees', async () => {
  const status = {
    thermostatMode: { thermostatMode: { value: 'heat' } },
    temperatureMeasurement: { temperature: { value: 70, unit: 'F' } },
  };
  const { service, msa } = createClimateService(ThermostatService, THERMOSTAT_CAPS, status);
  await service.getCurrentTemperature();
  await service.setTargetTemperature(22);
  const sent = msa.commands.at(-1)![0] as { arguments: number[] };
  assert.deepEqual(sent.arguments, [72]); // 71.6 °F rounded
});

function thermostatWithEvents() {
  const status = {
    thermostatMode: { thermostatMode: { value: 'cool' } },
    temperatureMeasurement: { temperature: { value: 21, unit: 'C' } },
  };
  const caps = ['temperatureMeasurement', 'thermostatHeatingSetpoint', 'thermostatMode', 'thermostatOperatingState'];
  const { service, accessory } = createClimateService(ThermostatService, caps, status);
  const tile = accessory.getService(hap.Service.Thermostat)!;
  const event = (capability: string, attribute: string, value: unknown) =>
    service.processEvent({ deviceId: 'd', componentId: 'main', capability, attribute, value });
  return { tile, event };
}

test('thermostat: thermostatMode events drive TargetHeatingCoolingState', () => {
  const { tile, event } = thermostatWithEvents();
  event('thermostatMode', 'thermostatMode', 'cool');
  assert.equal(tile.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).value,
    hap.Characteristic.TargetHeatingCoolingState.COOL);
});

test('thermostat: operating-state and list events do not flip the target mode to HEAT', () => {
  const { tile, event } = thermostatWithEvents();
  event('thermostatMode', 'thermostatMode', 'cool');
  event('thermostatOperatingState', 'thermostatOperatingState', 'idle');
  event('thermostatMode', 'supportedThermostatModes', ['heat', 'cool', 'off']);
  event('thermostatHeatingSetpoint', 'heatingSetpointRange', { minimum: 5, maximum: 30 });
  assert.equal(tile.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).value,
    hap.Characteristic.TargetHeatingCoolingState.COOL);
});

test('thermostat: thermostatOperatingState events drive CurrentHeatingCoolingState', () => {
  const { tile, event } = thermostatWithEvents();
  const current = () => tile.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState).value;
  event('thermostatOperatingState', 'thermostatOperatingState', 'heating');
  assert.equal(current(), hap.Characteristic.CurrentHeatingCoolingState.HEAT);
  event('thermostatOperatingState', 'thermostatOperatingState', 'idle');
  assert.equal(current(), hap.Characteristic.CurrentHeatingCoolingState.OFF);
  event('thermostatOperatingState', 'thermostatOperatingState', 'cooling');
  assert.equal(current(), hap.Characteristic.CurrentHeatingCoolingState.COOL);
  event('thermostatOperatingState', 'thermostatOperatingState', 'fan only');
  assert.equal(current(), hap.Characteristic.CurrentHeatingCoolingState.COOL); // unmapped: ignored
});

for (const [label, Fan, caps] of [
  ['fanSpeed', FanSpeedService, ['switch', 'fanSpeed']],
  ['fanSwitchLevel', FanSwitchLevelService, ['switch', 'fanSpeed', 'switchLevel']],
] as const) {
  test(`${label}: missing switch/level status rejects the read, no unhandled rejection`, async () => {
    const rejections = await collectUnhandledRejections(async () => {
      const { service } = createClimateService(Fan as any, [...caps], {});
      await assert.rejects(settleWithin(service.getSwitchState()), hap.HapStatusError);
      await assert.rejects(settleWithin(service.getLevel()), hap.HapStatusError);
    });
    assert.deepEqual(rejections, []);
  });
}

test('fanSpeed: a null fanSpeed is not reported as 100%', async () => {
  const status = { switch: { switch: { value: 'on' } }, fanSpeed: { fanSpeed: { value: null } } };
  const { service, accessory } = createClimateService(FanSpeedService, ['switch', 'fanSpeed'], status);
  await assert.rejects(settleWithin(service.getLevel()), hap.HapStatusError);
  const speed = accessory.getService(hap.Service.Fan)!.getCharacteristic(hap.Characteristic.RotationSpeed);
  speed.updateValue(33);
  service.processEvent({ deviceId: 'd', componentId: 'main', capability: 'fanSpeed', attribute: 'fanSpeed', value: null });
  assert.equal(speed.value, 33);
});
