import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as hap from 'hap-nodejs';
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { IKHomeBridgeHomebridgePlatform } from '../src/platform';
import { CrashLoopManager } from '../src/auth/CrashLoopManager';

// A logger that records every line (format args included) so tests can assert on log output.
export function recordingLog() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(a => typeof a === 'string' ? a : require('util').inspect(a)).join(' '));
  };
  return { lines, debug: record, info: record, warn: record, error: record, success: record, log: record };
}

export function tempStorage(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hb-st-core-'));
}

export function writeTokenFile(storage: string, data: Record<string, unknown>): string {
  const file = path.join(storage, 'smartthings_tokens.json');
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

export function validTokens(extra: Record<string, unknown> = {}) {
  return {
    access_token: 'file-access-token',
    refresh_token: 'file-refresh-token',
    expires_in: 86400,
    expires_at: Date.now() + 86400 * 1000,
    refresh_token_expires_at: Date.now() + 30 * 86400 * 1000,
    ...extra,
  };
}

// Fake Homebridge API: records registrations and keeps the lifecycle handlers so tests can fire them.
export function fakeApi(storage: string) {
  const handlers: Record<string, () => unknown> = {};
  return {
    hap,
    platformAccessory: PlatformAccessory,
    user: { storagePath: () => storage },
    on: (event: string, handler: () => unknown) => {
      handlers[event] = handler;
    },
    handlers,
    registered: [] as PlatformAccessory[][],
    unregistered: [] as PlatformAccessory[][],
    updated: [] as PlatformAccessory[][],
    registerPlatformAccessories(_plugin: string, _platform: string, accessories: PlatformAccessory[]) {
      this.registered.push(accessories);
    },
    unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: PlatformAccessory[]) {
      this.unregistered.push(accessories);
    },
    updatePlatformAccessories(accessories: PlatformAccessory[]) {
      this.updated.push(accessories);
    },
    publishExternalAccessories: () => undefined,
  };
}

// Build a real platform on a temp storage dir (no server_url, so no webhook server is started).
export function makePlatform(config: Record<string, unknown> = {}, storage = tempStorage(), log = recordingLog()) {
  (CrashLoopManager as unknown as { instance: unknown }).instance = null;
  const api = fakeApi(storage);
  const platform = new IKHomeBridgeHomebridgePlatform(
    log as never, { platform: 'HomeBridgeSmartThings', ...config } as never, api as never);
  return { platform, api, log, storage };
}

export type FakeResponse = { status: number; data?: unknown; headers?: Record<string, string> };

// Route axInstance requests to `respond` instead of the network. Non-2xx responses reject like axios does.
export function stubAdapter(platform: IKHomeBridgeHomebridgePlatform,
  respond: (config: InternalAxiosRequestConfig) => FakeResponse | Promise<FakeResponse>) {
  const calls: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    calls.push(config);
    const r = await respond(config);
    const response = { data: r.data, status: r.status, statusText: String(r.status), headers: r.headers || {}, config, request: {} };
    if (r.status >= 200 && r.status < 300) {
      return response;
    }
    const { AxiosError } = await import('axios');
    throw new AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_RESPONSE', config, {}, response as never);
  };
  platform.axInstance.defaults.adapter = adapter;
  return calls;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
