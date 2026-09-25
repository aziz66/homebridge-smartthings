import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { ContactSensorService } from '../src/services/contactSensorService';
import { MotionService } from '../src/services/motionService';
import { TemperatureService } from '../src/services/temperatureService';
import { HumidityService } from '../src/services/humidityService';
import { LightSensorService } from '../src/services/lightSensorService';
import { OccupancySensorService } from '../src/services/occupancySensorService';
import { LeakDetectorService } from '../src/services/leakDetector';
import { SmokeDetectorService } from '../src/services/smokeDetector';
import { CarbonMonoxideDetectorService } from '../src/services/carbonMonoxideDetector';
import { fakeAccessory, fakePlatform } from './helpers';

interface Poll {
  getValue: () => Promise<hap.CharacteristicValue>;
  service: hap.Service;
  characteristic: { UUID: string };
}

// Stands in for MultiServiceAccessory: records what each service asks startPollingState to poll.
function fakeMultiServiceAccessory() {
  const polls: Poll[] = [];
  return {
    polls,
    startPollingState: (_pollSeconds: number, getValue: Poll['getValue'], service: hap.Service, characteristic: Poll['characteristic']) => {
      polls.push({ getValue, service, characteristic });
    },
    isOnline: () => true,
    hasCachedStatus: () => true,
    refreshStatus: async () => true,
  };
}

const SENSORS = [
  { name: 'contact', Sensor: ContactSensorService, capability: 'contactSensor',
    service: hap.Service.ContactSensor, characteristic: hap.Characteristic.ContactSensorState },
  { name: 'motion', Sensor: MotionService, capability: 'motionSensor',
    service: hap.Service.MotionSensor, characteristic: hap.Characteristic.MotionDetected },
  { name: 'temperature', Sensor: TemperatureService, capability: 'temperatureMeasurement',
    service: hap.Service.TemperatureSensor, characteristic: hap.Characteristic.CurrentTemperature },
  { name: 'humidity', Sensor: HumidityService, capability: 'relativeHumidityMeasurement',
    service: hap.Service.HumiditySensor, characteristic: hap.Characteristic.CurrentRelativeHumidity },
  { name: 'light', Sensor: LightSensorService, capability: 'illuminanceMeasurement',
    service: hap.Service.LightSensor, characteristic: hap.Characteristic.CurrentAmbientLightLevel },
  { name: 'occupancy', Sensor: OccupancySensorService, capability: 'presenceSensor',
    service: hap.Service.OccupancySensor, characteristic: hap.Characteristic.OccupancyDetected },
  { name: 'leak', Sensor: LeakDetectorService, capability: 'waterSensor',
    service: hap.Service.LeakSensor, characteristic: hap.Characteristic.LeakDetected },
  { name: 'smoke', Sensor: SmokeDetectorService, capability: 'smokeDetector',
    service: hap.Service.SmokeSensor, characteristic: hap.Characteristic.SmokeDetected },
  { name: 'carbon monoxide', Sensor: CarbonMonoxideDetectorService, capability: 'carbonMonoxideDetector',
    service: hap.Service.CarbonMonoxideSensor, characteristic: hap.Characteristic.CarbonMonoxideDetected },
];

function createSensor(entry: typeof SENSORS[number], status: Record<string, unknown> = {}, accessory = fakeAccessory(
  `${entry.name} sensor`, [entry.capability])) {
  const multiServiceAccessory = fakeMultiServiceAccessory();
  new entry.Sensor(fakePlatform({ PollSensorsSeconds: 5 }), accessory, 'main', [entry.capability],
    multiServiceAccessory as any, `${entry.name} sensor`, { status });
  return { polls: multiServiceAccessory.polls, accessory };
}

for (const entry of SENSORS) {
  test(`${entry.name} sensor polls its own characteristic (#57)`, () => {
    const { polls } = createSensor(entry);
    assert.equal(polls.length, 1);
    assert.equal(polls[0].characteristic.UUID, entry.characteristic.UUID);
  });
}

test('a polled contact state lands on ContactSensorState, with no stray MotionDetected (#57)', async () => {
  const { polls, accessory } = createSensor(SENSORS[0], { contactSensor: { contact: { value: 'open' } } });
  const poll = polls[0];
  // One tick of MultiServiceAccessory.startPollingState: push the polled value.
  poll.service.updateCharacteristic(poll.characteristic as any, await poll.getValue());

  const service = accessory.getService(hap.Service.ContactSensor)!;
  assert.equal(service.getCharacteristic(hap.Characteristic.ContactSensorState).value,
    hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
  assert.equal(service.testCharacteristic(hap.Characteristic.MotionDetected), false);
});

test('a stray MotionDetected restored from the accessory cache is removed (#57)', () => {
  const accessory = fakeAccessory('Front door', ['contactSensor']);
  const cached = accessory.addService(hap.Service.ContactSensor);
  cached.addCharacteristic(hap.Characteristic.MotionDetected);

  createSensor(SENSORS[0], {}, accessory);

  assert.equal(accessory.getService(hap.Service.ContactSensor), cached);
  assert.equal(cached.testCharacteristic(hap.Characteristic.MotionDetected), false);
  assert.equal(cached.testCharacteristic(hap.Characteristic.ContactSensorState), true);
});

test('motion sensors keep MotionDetected', async () => {
  const { polls, accessory } = createSensor(SENSORS[1], { motionSensor: { motion: { value: 'active' } } });
  polls[0].service.updateCharacteristic(polls[0].characteristic as any, await polls[0].getValue());

  const service = accessory.getService(hap.Service.MotionSensor)!;
  assert.equal(service.getCharacteristic(hap.Characteristic.MotionDetected).value, true);
});
