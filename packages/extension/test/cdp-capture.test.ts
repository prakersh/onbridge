/**
 * Network capture and the console cursor.
 *
 * The network buffer is the first place a bearer token would leak: CDP hands us
 * every request header verbatim, and anything stored here flows to the agent's
 * context. Redaction has to happen at record time — a value that never enters
 * the buffer cannot be exfiltrated by any later layer, however buggy.
 *
 * cdp.ts wires chrome.* listeners at import time, so the stub must exist before
 * the module does. Events are then replayed through the captured listeners.
 */

import { describe, it, expect, beforeEach } from 'vitest';

type Listener = (...args: any[]) => void;

const listeners = {
  onEvent: [] as Listener[],
  onDetach: [] as Listener[],
  onRemoved: [] as Listener[],
  onBeforeNavigate: [] as Listener[],
};

let sendResult: (method: string) => { result?: any; error?: string } = () => ({ result: {} });
const sent: { method: string; params: any }[] = [];

(globalThis as any).chrome = {
  runtime: { lastError: undefined as { message: string } | undefined },
  debugger: {
    onEvent: { addListener: (f: Listener) => listeners.onEvent.push(f) },
    onDetach: { addListener: (f: Listener) => listeners.onDetach.push(f) },
    attach: (_t: any, _v: any, cb: () => void) => cb(),
    detach: (_t: any, cb: () => void) => cb(),
    sendCommand: (_t: any, method: string, params: any, cb: (r?: any) => void) => {
      sent.push({ method, params });
      const { result, error } = sendResult(method);
      const chrome = (globalThis as any).chrome;
      chrome.runtime.lastError = error ? { message: error } : undefined;
      cb(result);
      chrome.runtime.lastError = undefined;
    },
  },
  tabs: { onRemoved: { addListener: (f: Listener) => listeners.onRemoved.push(f) } },
  webNavigation: {
    onBeforeNavigate: { addListener: (f: Listener) => listeners.onBeforeNavigate.push(f) },
  },
};

const cdp = await import('../src/core/cdp.js');

function emit(tabId: number, method: string, params: any): void {
  for (const f of listeners.onEvent) f({ tabId }, method, params);
}

function request(tabId: number, requestId: string, url: string, extra: any = {}): void {
  emit(tabId, 'Network.requestWillBeSent', {
    requestId,
    request: { url, method: 'GET', headers: {}, ...extra.request },
    type: extra.type ?? 'Fetch',
    loaderId: extra.loaderId ?? 'loader-x',
  });
}

// Module-level state persists across tests; distinct tab ids keep them apart.
let nextTab = 1000;
let tab: number;
beforeEach(() => {
  tab = nextTab++;
  sendResult = () => ({ result: {} });
});

describe('network capture', () => {
  it('correlates request, response and completion by requestId', () => {
    request(tab, 'r1', 'https://example.test/api');
    emit(tab, 'Network.responseReceived', {
      requestId: 'r1',
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: { 'content-type': 'application/json' },
      },
    });
    emit(tab, 'Network.loadingFinished', { requestId: 'r1', encodedDataLength: 512 });

    const entries = cdp.getNetwork(tab);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.url).toBe('https://example.test/api');
    expect(e.method).toBe('GET');
    expect(e.status).toBe(200);
    expect(e.statusText).toBe('OK');
    expect(e.mimeType).toBe('application/json');
    expect(e.encodedDataLength).toBe(512);
    expect(e.startedAt).toBeTypeOf('number');
    expect(e.endedAt).toBeTypeOf('number');
    expect(e.failed).toBeUndefined();
  });

  it('redacts credential headers case-insensitively, keeping the names', () => {
    request(tab, 'r1', 'https://example.test/', {
      request: {
        url: 'https://example.test/',
        method: 'POST',
        headers: {
          Authorization: 'Bearer sekrit-token',
          COOKIE: 'session=abc',
          'X-Api-Key': 'k-123',
          'Proxy-Authorization': 'Basic zzz',
          Accept: 'text/html',
        },
      },
    });
    emit(tab, 'Network.responseReceived', {
      requestId: 'r1',
      response: {
        status: 200,
        headers: { 'Set-Cookie': 'session=abc; HttpOnly', Server: 'nginx' },
      },
    });

    const [e] = cdp.getNetwork(tab);
    expect(e.requestHeaders).toEqual({
      Authorization: '[redacted]',
      COOKIE: '[redacted]',
      'X-Api-Key': '[redacted]',
      'Proxy-Authorization': '[redacted]',
      Accept: 'text/html',
    });
    expect(e.responseHeaders).toEqual({ 'Set-Cookie': '[redacted]', Server: 'nginx' });
    expect(JSON.stringify(cdp.getNetwork(tab))).not.toContain('sekrit-token');
    expect(JSON.stringify(cdp.getNetwork(tab))).not.toContain('session=abc');
  });

  it('records failures and cache hits', () => {
    request(tab, 'r1', 'https://blocked.test/');
    emit(tab, 'Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
    request(tab, 'r2', 'https://cached.test/app.js');
    emit(tab, 'Network.requestServedFromCache', { requestId: 'r2' });

    const [failed, cached] = cdp.getNetwork(tab);
    expect(failed.failed).toBe('net::ERR_BLOCKED_BY_CLIENT');
    expect(failed.endedAt).toBeTypeOf('number');
    expect(cached.fromCache).toBe(true);
  });

  it('ignores events for requests it never saw start', () => {
    emit(tab, 'Network.responseReceived', { requestId: 'ghost', response: { status: 200 } });
    emit(tab, 'Network.loadingFinished', { requestId: 'ghost', encodedDataLength: 1 });
    expect(cdp.getNetwork(tab)).toHaveLength(0);
  });

  it('caps the buffer at 200 entries, dropping oldest first', () => {
    for (let i = 0; i < 250; i++) request(tab, `r${i}`, `https://example.test/${i}`);
    const entries = cdp.getNetwork(tab);
    expect(entries).toHaveLength(200);
    expect(entries[0].url).toBe('https://example.test/50');
    expect(entries[199].url).toBe('https://example.test/249');
  });

  it('clears on top-frame navigation but not on iframe navigation', () => {
    request(tab, 'r1', 'https://old.test/');
    for (const f of listeners.onBeforeNavigate) f({ tabId: tab, frameId: 7, url: 'https://iframe.test/' });
    expect(cdp.getNetwork(tab)).toHaveLength(1);
    for (const f of listeners.onBeforeNavigate) f({ tabId: tab, frameId: 0, url: 'https://new.test/' });
    expect(cdp.getNetwork(tab)).toHaveLength(0);
  });

  it('clears on detach and on tab removal, and via clearNetwork', () => {
    request(tab, 'r1', 'https://example.test/');
    cdp.clearNetwork(tab);
    expect(cdp.getNetwork(tab)).toHaveLength(0);

    request(tab, 'r2', 'https://example.test/');
    for (const f of listeners.onDetach) f({ tabId: tab });
    expect(cdp.getNetwork(tab)).toHaveLength(0);

    request(tab, 'r3', 'https://example.test/');
    for (const f of listeners.onRemoved) f(tab);
    expect(cdp.getNetwork(tab)).toHaveLength(0);
  });

  it('enableNetworkCapture is idempotent and survives a failing Network.enable', async () => {
    await cdp.enableNetworkCapture(tab);
    await cdp.enableNetworkCapture(tab);
    expect(sent.filter((s) => s.method === 'Network.enable').length).toBeGreaterThanOrEqual(1);

    const tab2 = nextTab++;
    sendResult = (m) => (m === 'Network.enable' ? { error: 'nope' } : { result: {} });
    await expect(cdp.enableNetworkCapture(tab2)).resolves.toBeUndefined();
  });
});

describe('getResponseBody', () => {
  it('returns the body when CDP has it', async () => {
    sendResult = (m) =>
      m === 'Network.getResponseBody'
        ? { result: { body: 'aGVsbG8=', base64Encoded: true } }
        : { result: {} };
    await expect(cdp.getResponseBody(tab, 'r1')).resolves.toEqual({
      body: 'aGVsbG8=',
      base64Encoded: true,
    });
  });

  it('returns null when the body is gone', async () => {
    sendResult = (m) =>
      m === 'Network.getResponseBody' ? { error: 'No resource with given identifier' } : { result: {} };
    await expect(cdp.getResponseBody(tab, 'r1')).resolves.toBeNull();
  });
});

describe('console cursor', () => {
  const log = (text: string) =>
    emit(tab, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: text }] });

  it('returns only entries recorded after the cursor', () => {
    log('before');
    const cursor = cdp.consoleCursor(tab);
    log('after-1');
    log('after-2');
    expect(cdp.consoleSince(tab, cursor).map((e) => e.text)).toEqual(['after-1', 'after-2']);
    expect(cdp.consoleSince(tab, cdp.consoleCursor(tab))).toEqual([]);
  });

  it('returns what remains when eviction has passed the cursor', () => {
    const cursor = cdp.consoleCursor(tab);
    for (let i = 0; i < 250; i++) log(`line ${i}`);
    const since = cdp.consoleSince(tab, cursor);
    expect(since).toHaveLength(200);
    expect(since[0].text).toBe('line 50');
  });

  it('keeps old cursors meaningful across clearConsole', () => {
    log('old');
    const cursor = cdp.consoleCursor(tab);
    cdp.clearConsole(tab);
    log('fresh');
    expect(cdp.consoleSince(tab, cursor).map((e) => e.text)).toEqual(['fresh']);
  });
});
