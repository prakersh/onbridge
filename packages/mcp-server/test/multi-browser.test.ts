/**
 * One agent, several browsers. Every copy of the store extension shares one extension id, so the server tells browser profiles apart by the install id each sends in `hello`: one pairing and one live connection per install, with commands going to the browser that granted control most recently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HANDSHAKE_VERSION } from '@onbridge/shared';
import {
  startServer,
  openSession,
  connect,
  waitForListening,
  adoptPairing,
  EXT_ID,
  EXT_ORIGIN,
  type Harness,
  type Session,
} from './session-helper.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

let h: Harness;
const open: Session[] = [];

beforeAll(async () => {
  h = startServer();
  await h.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } });
  await waitForListening();
});

afterAll(async () => {
  for (const s of open) await s.close();
  h?.stop();
});

const textOf = (res: any): string => (res.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const peers = () => JSON.parse(readFileSync(join(h.home, 'peers.json'), 'utf8')).peers as Record<string, Record<string, unknown>>;
/** `openSession` resolves once it has *sent* its last handshake frame; the server writes the record when it has processed it. */
const keysOnceSettled = async (want: (keys: string[]) => boolean) => {
  for (let i = 0; i < 40; i++) {
    const keys = Object.keys(peers());
    if (want(keys)) return keys;
    await sleep(50);
  }
  return Object.keys(peers());
};
const urlNow = async () => textOf(await h.rpc('tools/call', { name: 'get_url', arguments: {} }));

describe('two browsers, one agent', () => {
  let a: Session;
  let b: Session;

  it('pairs both, each under its own record, and keeps both connected', async () => {
    a = await openSession({ installId: A });
    b = await openSession({ installId: B });
    open.push(a, b);
    a.onCommand(() => ({ url: 'https://browser-a.example/', title: 'A' }));
    b.onCommand(() => ({ url: 'https://browser-b.example/', title: 'B' }));

    const keys = await keysOnceSettled((k) => k.includes(`${EXT_ID}#${A}`) && k.includes(`${EXT_ID}#${B}`));
    expect(keys).toContain(`${EXT_ID}#${A}`);
    expect(keys).toContain(`${EXT_ID}#${B}`);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    expect(b.ws.readyState).toBe(b.ws.OPEN);
  });

  it('sends commands to the browser that granted control most recently', async () => {
    await a.emit({ type: 'ready', version: '0.5.0', controlMode: true });
    await sleep(100);
    expect(await urlNow()).toContain('browser-a');

    await b.emit({ type: 'ready', version: '0.5.0', controlMode: true });
    await sleep(100);
    expect(await urlNow()).toContain('browser-b');
  });

  it('goes back to the other browser only when the user grants it there again', async () => {
    // B's grant took control away from A (A was told, and a real extension puts it on hold), so B releasing leaves nobody in control until the user picks again.
    await b.emit({ type: 'released' });
    await a.emit({ type: 'ready', version: '0.5.0', controlMode: true });
    await sleep(100);
    expect(await urlNow()).toContain('browser-a');
  });

  it('still refuses a second live connection from the same install', async () => {
    const ws = await connect(EXT_ORIGIN);
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      ws.on('close', (code, reason) => r({ code, reason: reason.toString() })),
    );
    ws.send(JSON.stringify({ t: 'hello', v: HANDSHAKE_VERSION, extId: EXT_ID, ePub: 'x', eNonce: 'x', installId: A }));
    expect(await closed).toEqual({ code: 4000, reason: 'Another client is already connected' });
  });
});

describe('a pairing made before install ids', () => {
  it('is still accepted, and moves to the install that proves it holds the secret', async () => {
    const legacy = await openSession();
    expect(await keysOnceSettled((k) => k.includes(EXT_ID))).toContain(EXT_ID);
    await legacy.close();

    adoptPairing(C); // the same browser, now on an extension that sends an install id
    const upgraded = await openSession({ installId: C });
    open.push(upgraded);

    const keys = await keysOnceSettled((k) => k.includes(`${EXT_ID}#${C}`) && !k.includes(EXT_ID));
    expect(keys).toContain(`${EXT_ID}#${C}`);
    expect(keys).not.toContain(EXT_ID);
  });
});

describe('an old extension and a new one, side by side', () => {
  it('pair and stay paired without either overwriting the other', async () => {
    const D = 'd'.repeat(32);
    const before = await keysOnceSettled(() => true);
    const oldOne = await openSession(); // sends no install id: the bare record
    open.push(oldOne);
    const newOne = await openSession({ installId: D });
    open.push(newOne);
    const keys = await keysOnceSettled((k) => k.includes(EXT_ID) && k.includes(`${EXT_ID}#${D}`));
    expect(keys).toContain(EXT_ID);
    expect(keys).toContain(`${EXT_ID}#${D}`);
    const recs = peers();
    expect(recs[EXT_ID]).not.toEqual(recs[`${EXT_ID}#${D}`]);
    // Nothing that existed before was dropped.
    for (const k of before) expect(keys).toContain(k);
    expect(oldOne.ws.readyState).toBe(oldOne.ws.OPEN);
    expect(newOne.ws.readyState).toBe(newOne.ws.OPEN);
  });
});


describe('the browser the user picks', () => {
  it('has the other browsers’ waiting pairing prompts withdrawn once the user approves in it', async () => {
    const waiting = '1'.repeat(32);
    const chosen = '2'.repeat(32);
    let waitingWs: import('ws').WebSocket | undefined;
    // Never approved: this browser's prompt is still on screen when the user approves in the other.
    void openSession({ installId: waiting, approve: new Promise(() => {}), onSocket: (ws) => (waitingWs = ws) }).catch(() => {});
    await sleep(500);
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      waitingWs!.on('close', (code, reason) => r({ code, reason: reason.toString() })),
    );
    const picked = await openSession({ installId: chosen });
    open.push(picked);
    expect(await closed).toEqual({ code: 4003, reason: 'paired in another browser' });
    expect(picked.ws.readyState).toBe(picked.ws.OPEN);
  });

  it('tells the browser that had control when the user gives it to another', async () => {
    const heard: string[] = [];
    const first = await openSession({ installId: '3'.repeat(32), onServerMessage: (m) => heard.push(m.type) });
    const second = await openSession({ installId: '4'.repeat(32) });
    open.push(first, second);
    await first.emit({ type: 'ready', version: '0.5.0', controlMode: true });
    await sleep(100);
    expect(heard).not.toContain('control_moved');
    await second.emit({ type: 'ready', version: '0.5.0', controlMode: true });
    await sleep(200);
    expect(heard).toContain('control_moved');
  });
});
