import * as hap from 'hap-nodejs';
import { fakeAccessory, fakePlatform } from './helpers';

export interface Poll {
  pollSeconds: number;
  getValue: () => Promise<hap.CharacteristicValue>;
  characteristic: { UUID: string };
}

export interface Command {
  componentId: string;
  capability: string;
  command: string;
  args?: unknown[];
}

// Stands in for MultiServiceAccessory: records polls and commands; commandResult drives sendCommand().
export function fakeMultiServiceAccessory(options: { commandResult?: boolean; statusResult?: boolean; cached?: boolean } = {}) {
  const fake = {
    polls: [] as Poll[],
    commands: [] as Command[],
    forcedRefreshes: 0,
    commandResult: options.commandResult ?? true,
    components: [] as unknown[],
    startPollingState: (pollSeconds: number, getValue: Poll['getValue'], _service: hap.Service, characteristic: Poll['characteristic']) => {
      fake.polls.push({ pollSeconds, getValue, characteristic });
    },
    isOnline: () => true,
    hasCachedStatus: () => options.cached ?? true,
    refreshStatus: async () => options.statusResult ?? true,
    forceNextStatusRefresh: () => {
      fake.forcedRefreshes++;
    },
    sendCommand: async (componentId: string, capability: string, command: string, args?: unknown[]) => {
      fake.commands.push({ componentId, capability, command, args });
      return fake.commandResult;
    },
    sendCommands: async (commands: Command[]) => {
      fake.commands.push(...commands);
      return fake.commandResult;
    },
  };
  return fake;
}

type ServiceCtor = new (...args: any[]) => any;

// Builds a device service the way MultiServiceAccessory.addComponent does, with fakes around it.
export function makeService<T extends ServiceCtor>(Ctor: T, capabilities: string[], options: {
  status?: Record<string, unknown>;
  config?: Record<string, unknown>;
  commandResult?: boolean;
  statusResult?: boolean;
  cached?: boolean;
} = {}) {
  const platform = fakePlatform(options.config ?? {});
  const accessory = fakeAccessory(`Test ${Ctor.name}`, capabilities);
  const msa = fakeMultiServiceAccessory(options);
  const deviceStatus = { status: options.status ?? {} };
  const instance: InstanceType<T> = new Ctor(platform, accessory, 'main', capabilities, msa as never, `Test ${Ctor.name}`,
    deviceStatus);
  return { instance, accessory, msa, deviceStatus, service: instance.service as hap.Service };
}

// Collects unhandled promise rejections (fatal to Homebridge) raised while fn runs plus a few ticks.
export async function collectUnhandledRejections(fn: () => void | Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await fn();
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
  return seen;
}

export function isCommFailure(error: unknown): boolean {
  return error instanceof hap.HapStatusError && error.hapStatus === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
}
