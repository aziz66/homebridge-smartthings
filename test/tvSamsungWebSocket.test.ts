import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { SamsungWebSocket } from '../src/local/samsungWebSocket';
import { fakeTv, pointAt, recordingLog, tempStorage } from './tvHelpers';

const tokenFile = (dir: string) => path.join(dir, 'samsung_tv_token_127.0.0.1.json');

function saveTokenFile(dir: string, token: string) {
  fs.writeFileSync(tokenFile(dir), JSON.stringify({ token, ip: '127.0.0.1' }));
}

async function elapsed<T>(fn: () => Promise<T>): Promise<{ ms: number; error?: Error; value?: T }> {
  const start = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - start, value };
  } catch (error) {
    return { ms: Date.now() - start, error: error as Error };
  }
}

test('remote connect rejects promptly when the TV closes before the channel handshake', async () => {
  const tv = await fakeTv(socket => socket.close());
  const sws = pointAt(new SamsungWebSocket('127.0.0.1', recordingLog().log, tempStorage(), 'tok1'), tv.port);
  try {
    const { ms, error } = await elapsed(() => sws.clickKey('KEY_UP', 4000));
    assert.ok(error, 'clickKey must reject');
    assert.match(error!.message, /closed before the channel connected/);
    assert.ok(ms < 3000, `rejected after ${ms}ms, expected well before the 4s connect timeout`);
    // The attempt is no longer "in flight": a second call connects afresh rather than waiting.
    const second = await elapsed(() => sws.clickKey('KEY_UP', 4000));
    assert.match(second.error!.message, /closed before the channel connected/);
  } finally {
    sws.destroy();
    await tv.close();
  }
});

test('art connect rejects promptly when the TV closes before the channel is ready', async () => {
  const tv = await fakeTv(socket => socket.close());
  const { log, lines } = recordingLog();
  const sws = pointAt(new SamsungWebSocket('127.0.0.1', log, tempStorage()), tv.port);
  try {
    const { ms, error } = await elapsed(() => sws.getArtModeStatus());
    assert.ok(error, 'getArtModeStatus must reject so the Art Mode poll can count the failure');
    assert.match(error!.message, /closed before the channel was ready/);
    assert.ok(ms < 1900, `rejected after ${ms}ms`);
    const second = await elapsed(() => sws.getArtModeStatus());
    assert.match(second.error!.message, /closed before the channel was ready/);
    assert.equal(lines.filter(l => l.level === 'error').length, 0, 'routine art failures are not logged at error');
  } finally {
    sws.destroy();
    await tv.close();
  }
});

test('art connect settles when a stale art socket is still set', async () => {
  const tv = await fakeTv(socket => {
    socket.send(JSON.stringify({ event: 'ms.channel.ready' }));
    socket.on('message', () => socket.send(JSON.stringify({
      event: 'd2d_service_message', data: JSON.stringify({ event: 'get_artmode_status', value: 'on' }),
    })));
  });
  const sws = pointAt(new SamsungWebSocket('127.0.0.1', recordingLog().log, tempStorage()), tv.port);
  // A socket the TV is closing: set, but not OPEN.
  (sws as any).artWs = { readyState: 2, close: () => undefined };
  try {
    const { error, value } = await elapsed(() => sws.getArtModeStatus());
    assert.equal(error, undefined);
    assert.equal(value, 'on');
    assert.equal((sws as any).artConnecting, false);
  } finally {
    sws.destroy();
    await tv.close();
  }
});

test('holdKey still succeeds when the TV drops the socket after the Press (it is powering off)', async () => {
  const tv = await fakeTv(socket => {
    socket.send(JSON.stringify({ event: 'ms.channel.connect', data: {} }));
    socket.on('message', () => socket.close()); // drop right after the Press
  });
  const sws = pointAt(new SamsungWebSocket('127.0.0.1', recordingLog().log, tempStorage(), 'tok1'), tv.port);
  try {
    await assert.doesNotReject(sws.holdKey('KEY_POWER', 300));
  } finally {
    sws.destroy();
    await tv.close();
  }
});

test('a saved pairing token takes precedence over the config token', () => {
  const dir = tempStorage();
  saveTokenFile(dir, 'saved-token');
  const sws = new SamsungWebSocket('127.0.0.1', recordingLog().log, dir, 'config-token');
  assert.equal((sws as any).token, 'saved-token');
});

test('the config token is used when nothing has been saved', () => {
  const sws = new SamsungWebSocket('127.0.0.1', recordingLog().log, tempStorage(), 'config-token');
  assert.equal((sws as any).token, 'config-token');
});

test('an unauthorized reply deletes the saved token only when that token was the one rejected', async () => {
  const tv = await fakeTv(socket => socket.send(JSON.stringify({ event: 'ms.channel.unauthorized' })));
  try {
    // Rejected token came from config; a newer token has since been saved - keep it.
    const keepDir = tempStorage();
    const keep = pointAt(new SamsungWebSocket('127.0.0.1', recordingLog().log, keepDir, 'config-token'), tv.port);
    saveTokenFile(keepDir, 'newer-token');
    await assert.rejects(keep.clickKey('KEY_UP', 2000), /Authorization denied/);
    assert.ok(fs.existsSync(tokenFile(keepDir)), 'a token that was not rejected must survive');
    keep.destroy();

    // The saved token itself was rejected - delete it.
    const dropDir = tempStorage();
    saveTokenFile(dropDir, 'saved-token');
    const drop = pointAt(new SamsungWebSocket('127.0.0.1', recordingLog().log, dropDir), tv.port);
    await assert.rejects(drop.clickKey('KEY_UP', 2000), /Authorization denied/);
    assert.equal(fs.existsSync(tokenFile(dropDir)), false);
    assert.equal(drop.hasToken(), false);
    drop.destroy();
  } finally {
    await tv.close();
  }
});

test('pairing saves the token without printing it in full', async () => {
  const token = 'abcdefgh12345678';
  const tv = await fakeTv(socket => socket.send(JSON.stringify({ event: 'ms.channel.connect', data: { token } })));
  const dir = tempStorage();
  const { log, lines } = recordingLog();
  const sws = pointAt(new SamsungWebSocket('127.0.0.1', log, dir), tv.port);
  try {
    await sws.clickKey('KEY_UP', 2000);
    assert.equal(JSON.parse(fs.readFileSync(tokenFile(dir), 'utf-8')).token, token);
    assert.equal(lines.some(l => l.msg.includes(token)), false, 'full token must not be logged');
    assert.ok(lines.some(l => l.level === 'info' && l.msg.includes('...5678')));
  } finally {
    sws.destroy();
    await tv.close();
  }
});
