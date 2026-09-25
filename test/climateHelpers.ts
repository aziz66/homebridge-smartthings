import * as hap from 'hap-nodejs';
import { fakeAccessory, fakePlatform } from './helpers';

export interface Poll {
  getValue: () => Promise<hap.CharacteristicValue>;
  service: hap.Service;
  characteristic: { UUID: string };
}

export interface FakeMsaOptions {
  // Result of a (blocking) status refresh; false simulates a failed SmartThings GET.
  refreshResult?: boolean;
  // Whether a cached status already exists (getStatus then returns immediately).
  cached?: boolean;
  sendResult?: boolean;
}

// Stands in for MultiServiceAccessory: records polls, commands and forced refreshes.
export function fakeMultiServiceAccessory(capabilities: string[], options: FakeMsaOptions = {}) {
  const polls: Poll[] = [];
  const commands: unknown[][] = [];
  const counters = { forceNextStatusRefresh: 0, refreshStatus: 0 };
  return {
    polls,
    commands,
    counters,
    components: [{ componentId: 'main', capabilities, status: {} }],
    startPollingState: (_pollSeconds: number, getValue: Poll['getValue'], service: hap.Service, characteristic: Poll['characteristic']) => {
      polls.push({ getValue, service, characteristic });
    },
    isOnline: () => true,
    hasCachedStatus: () => options.cached ?? true,
    refreshStatus: async () => {
      counters.refreshStatus++;
      return options.refreshResult ?? true;
    },
    forceNextStatusRefresh: () => {
      counters.forceNextStatusRefresh++;
    },
    sendCommands: async (cmds: unknown[]) => {
      commands.push(cmds);
      return options.sendResult ?? true;
    },
    sendCommand: async (componentId: string, capability: string, command: string, args?: unknown[]) => {
      commands.push([{ component: componentId, capability, command, arguments: args }]);
      return options.sendResult ?? true;
    },
  };
}

// Builds a climate service with a fake accessory/platform. `status` is the live component status object.
export function createClimateService<T>(
  Service: new (...args: any[]) => T,
  capabilities: string[],
  status: Record<string, unknown> = {},
  options: FakeMsaOptions = {},
  config: Record<string, unknown> = { PollSensorsSeconds: 5, PollSwitchesAndLightsSeconds: 5 },
) {
  const accessory = fakeAccessory('Climate device', capabilities);
  const msa = fakeMultiServiceAccessory(capabilities, options);
  const deviceStatus = { status };
  const service = new Service(fakePlatform(config), accessory, 'main', capabilities, msa as any, 'Climate device', deviceStatus);
  return { service: service as any, accessory, msa, deviceStatus };
}

// Collects unhandled rejections raised while `fn` runs (plus a few macrotask turns afterwards).
export async function collectUnhandledRejections(fn: () => unknown | Promise<unknown>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const listener = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await fn();
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally {
    process.off('unhandledRejection', listener);
  }
  return rejections;
}

// Rejects if `promise` has not settled within `ms` (a hung HomeKit read).
export function settleWithin<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
