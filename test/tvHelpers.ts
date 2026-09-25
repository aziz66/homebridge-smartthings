import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { SamsungWebSocket } from '../src/local/samsungWebSocket';

// A logger that records every line, so tests can assert on what was (not) logged.
export function recordingLog() {
  const lines: { level: string; msg: string }[] = [];
  const at = (level: string) => (...args: unknown[]) => {
    lines.push({ level, msg: args.map(String).join(' ') });
  };
  return {
    lines,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), success: at('info'), log: at('info') } as any,
  };
}

export function tempStorage(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hb-st-tv-'));
}

// A throwaway WebSocket server on 127.0.0.1 standing in for the TV. `onConnection`
// scripts the TV's side of each connection.
export async function fakeTv(onConnection: (socket: WebSocket, url: string) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, req) => onConnection(socket, req.url ?? ''));
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>(resolve => {
      server.clients.forEach(c => c.terminate());
      server.close(() => resolve());
    }),
  };
}

// SamsungWebSocket hard-codes the TV's ports (8002/8001); point both channels at the fake TV.
export function pointAt(sws: SamsungWebSocket, port: number): SamsungWebSocket {
  Object.defineProperty(sws, 'remoteUrl', {
    get() {
      const token = (sws as any).token;
      return `ws://127.0.0.1:${port}/remote${token ? `?token=${token}` : ''}`;
    },
  });
  Object.defineProperty(sws, 'artModeUrl', { get: () => `ws://127.0.0.1:${port}/art` });
  return sws;
}
