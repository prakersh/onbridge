/**
 * One agent, two browsers, default settings (apart from the test port range), end to end.
 *
 * Two Chromium profiles each load the built extension; one MCP server runs with no ONBRIDGE_* configuration at all, so it connects on demand and accepts only the official extension id. Everything a user would do happens through each profile's real side panel.
 *
 *   ./app.sh --build && node scripts/verify-multi-browser.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = join(ROOT, 'packages/extension/.output/chrome-mv3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Tests run on their own port range, in both directions: the servers listen there (ONBRIDGE_PORT_BASE) and the test browser scans only there (onbridge_port_base in its storage). Otherwise a test browser, which has the published extension id, reaches the user's real agents, and the user's browser reaches the test's.
const TEST_PORT_BASE = 19876;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures++;
};

// The id Chrome assigns: from the manifest key when present, else from the path.
const { key } = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const EXT_ID = createHash('sha256')
  .update(key ? Buffer.from(key, 'base64') : EXT)
  .digest('hex')
  .slice(0, 32)
  .split('')
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

/** A page per browser, so where a command landed is visible in its result. */
function startPage(label) {
  const srv = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Browser ${label}</title><h1>Browser ${label}</h1>`);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/${label}` })));
}

function startMcp(home) {
  const env = { ...process.env, ONBRIDGE_HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith('ONBRIDGE_') && k !== 'ONBRIDGE_HOME') delete env[k];
  env.ONBRIDGE_PORT_BASE = String(TEST_PORT_BASE);
  const proc = spawn('node', [join(ROOT, 'packages/mcp-server/dist/index.js')], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let log = '';
  proc.stderr.on('data', (d) => {
    log += d;
    if (process.env.V) process.stderr.write(`[srv] ${d}`);
  });
  let buf = '';
  const waiters = new Map();
  proc.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      try {
        const m = JSON.parse(l);
        waiters.get(m.id)?.(m);
        waiters.delete(m.id);
      } catch {
        /* partial line */
      }
    }
  });
  let id = 1;
  const rpc = (method, params = {}, timeoutMs = 120_000) =>
    new Promise((res, rej) => {
      const i = id++;
      waiters.set(i, res);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
      setTimeout(() => waiters.delete(i) && rej(new Error(`${method} timed out`)), timeoutMs);
    });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return (r.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  };
  return { proc, rpc, call, log: () => log };
}

const WebSocket = createRequire(join(ROOT, 'packages/mcp-server/package.json'))('ws');

const freePort = () =>
  new Promise((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });

/**
 * What Chrome itself logs for the extension's worker, over the DevTools protocol. Some errors never pass through the extension's code (a failed WebSocket connection is one), so a trap inside the worker cannot see them; they still land on chrome://extensions for the user.
 */
async function watchChromeLog(debugPort) {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes('background'));
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  const errors = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Log.enable' }));
  return { errors, close: () => ws.close() };
}

async function openBrowser(label, pageUrl) {
  const profile = mkdtempSync(join(tmpdir(), `onbridge-profile-${label}-`));
  const debugPort = await freePort();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--remote-debugging-port=${debugPort}`],
  });
  // Records what the extension's worker throws or logs as an error, so a check can fail on it.
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await sw.evaluate(() => {
    self.__onbridgeErrors = [];
    const note = (x) => self.__onbridgeErrors.push(String(x?.message ?? x));
    self.addEventListener('error', (e) => note(e.message));
    self.addEventListener('unhandledrejection', (e) => note(e.reason));
    const original = console.error;
    console.error = (...a) => {
      note(a.join(' '));
      original(...a);
    };
  });
  const chromeLog = await watchChromeLog(debugPort);
  const errors = async () => [
    ...(await sw.evaluate(() => self.__onbridgeErrors ?? []).catch(() => ['(worker restarted; errors before that are lost)'])),
    ...chromeLog.errors,
  ];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(pageUrl);
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await page.bringToFront();
  const send = (msg) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
  const windowId = await panel.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
  const status = () => send({ type: 'get_status', windowId });
  const installId = () => panel.evaluate(() => chrome.storage.local.get('onbridge_install_id').then((r) => r.onbridge_install_id));
  const setPortBase = (base) => panel.evaluate((b) => chrome.storage.local.set({ onbridge_port_base: b }), base);
  return { label, ctx, profile, send, status, windowId, installId, setPortBase, errors, chromeLog };
}

/** Approves any pairing prompt, until this browser holds an authenticated session for the agent on `port`. */
async function pairUp(b, port, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = await b.status();
    if (st?.pairRequest) await b.send({ type: 'resolve_pairing', allow: true });
    const s = (st?.sessions ?? []).find((x) => x.port === port && (x.status === 'on_hold' || x.status === 'active'));
    if (s) return s;
    await sleep(300);
  }
  return null;
}

async function main() {
  if (!existsSync(join(EXT, 'manifest.json'))) {
    console.error('No built extension. Run ./app.sh --build first.');
    process.exit(2);
  }
  console.log(`extension id: ${EXT_ID}\n`);
  const home = mkdtempSync(join(tmpdir(), 'onbridge-home-'));
  const pageA = await startPage('A');
  const pageB = await startPage('B');
  const mcp = startMcp(home);
  const browsers = [];
  try {
    await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'multi-browser-check', version: '1' } });

    console.log('Connecting on first use');
    await sleep(2000);
    check(!/listening on/.test(mcp.log()), 'the server does not listen before the agent calls a tool', mcp.log());

    const a = await openBrowser('A', pageA.url);
    const b = await openBrowser('B', pageB.url);
    browsers.push(a, b);
    for (const x of [a, b]) {
      await x.setPortBase(TEST_PORT_BASE);
      await x.send({ type: 'set_scope', scope: 'window' });
      await x.send({ type: 'set_control_mode', enabled: true });
    }

    // The agent's first call: the server starts listening, both browsers find it and pair, and the call returns within the same turn.
    const first = mcp.call('get_url');
    let port = 0;
    for (let i = 0; i < 40 && !port; i++) {
      port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(mcp.log())?.[1] ?? 0);
      if (!port) await sleep(250);
    }
    check(port > 0, 'the first tool call starts the server listening');
    check(port >= TEST_PORT_BASE, 'the test server is on the test port range, where no real browser looks', `port ${port}`);
    // Both browsers are asked. The user approves in A; B's prompt must go away on its own, without an error or a second prompt.
    let sa = null;
    for (let i = 0; i < 300 && !sa; i++) {
      const sta = await a.status(); // B is deliberately left unanswered
      if (sta?.pairRequest) await a.send({ type: 'resolve_pairing', allow: true, port });
      sa = (sta?.sessions ?? []).find((x) => x.port === port && (x.status === 'on_hold' || x.status === 'active')) ?? null;
      if (!sa) await sleep(300);
    }
    check(Boolean(sa), 'browser A pairs with the agent when the user approves there');
    const firstText = await first;
    check(!/not connected/i.test(firstText), 'that first call completes connected rather than failing', firstText);

    let bState = null;
    for (let i = 0; i < 40; i++) {
      bState = await b.status();
      const s = (bState?.sessions ?? []).find((x) => x.port === port);
      if (!(bState?.pairRequests ?? []).length && s?.status === 'failed') break;
      await sleep(250);
    }
    const bSession = (bState?.sessions ?? []).find((x) => x.port === port);
    check(!(bState?.pairRequests ?? []).length, "B's pairing prompt is withdrawn once the user approved in A", JSON.stringify(bState?.pairRequests));
    check(bSession?.detail === 'paired in another browser', 'B records why, as a decision rather than a failure', bSession?.detail);
    await sleep(12_000); // a full sweep and more
    const bLater = await b.status();
    check(!(bLater?.pairRequests ?? []).length, 'B does not ask again on its next sweep', JSON.stringify(bLater?.pairRequests));

    // The user decides they want the agent in B too: "Accept new agents" brings it back.
    await b.send({ type: 'arm_pairing' });
    const sb = await pairUp(b, port, 45_000);
    check(Boolean(sb), 'B pairs too, once the user asks for new agents there');
    if (!sa || !sb) throw new Error('a browser never paired, so the checks that follow have nothing to act on');

    console.log('\nOne pairing per browser');
    const peers = JSON.parse(readFileSync(join(home, 'peers.json'), 'utf8')).peers;
    const [ia, ib] = [await a.installId(), await b.installId()];
    check(Boolean(ia && ib && ia !== ib), 'each profile has its own install id', `${ia} / ${ib}`);
    check(Boolean(peers[`${EXT_ID}#${ia}`]) && Boolean(peers[`${EXT_ID}#${ib}`]), 'the server holds a separate pairing for each', Object.keys(peers).join(', '));
    check(!mcp.log().includes('Another client is already connected'), 'neither browser was turned away');
    const contacted = [...(await a.status()).sessions, ...(await b.status()).sessions].map((s) => s.port);
    check(contacted.every((p) => p >= TEST_PORT_BASE), "the test browsers never contacted a real agent's port", contacted.join(', '));

    console.log('\nBefore any grant');
    const early = await mcp.call('bridge_status');
    const code = /Connection code: ([A-Z0-9]{4})/.exec(early)?.[1];
    check(/Extension: CONNECTED/.test(early) && /nothing yet/.test(early), 'bridge_status answers before control is granted, and says what to ask for', early.split('\n').slice(0, 4).join(' / '));
    check(Boolean(code) && sa.agent?.code === code, "the connection code the agent sees is the one on the browser's card", `${code} vs ${sa.agent?.code}`);
    const refusal = await mcp.call('get_url');
    check(/Give this agent control/.test(refusal) && !/untrusted-page-content/.test(refusal), "onbridge's own refusal reaches the agent as onbridge's, not fenced as page text", refusal.slice(0, 160));
    check(Boolean(code) && refusal.includes(code), 'the refusal names the connection code to look for', refusal.slice(0, 200));

    console.log('\nCommands follow the grant');
    let r = await a.send({ type: 'activate_session', id: sa.id, windowId: a.windowId, scope: 'window' });
    check(r?.ok, 'browser A gives the agent control', JSON.stringify(r));
    await sleep(300);
    let url = await mcp.call('get_url');
    check(url.includes('/A'), 'the agent acts in browser A', url);

    r = await b.send({ type: 'activate_session', id: sb.id, windowId: b.windowId, scope: 'window' });
    check(r?.ok, 'browser B gives the agent control', JSON.stringify(r));
    await sleep(300);
    url = await mcp.call('get_url');
    check(url.includes('/B'), 'the agent now acts in browser B, the most recent grant', url);
    const aNow = (await a.status()).sessions.find((x) => x.id === sa.id);
    check(aNow?.status === 'on_hold', "A's panel shows the agent on hold once B took control", aNow?.status);

    await b.send({ type: 'hold_session', id: sb.id });
    await sleep(300);
    url = await mcp.call('get_url');
    check(/Give this agent control/i.test(url), 'with control taken back in B and none in A, the agent is told to ask for it', url);

    r = await a.send({ type: 'activate_session', id: sa.id, windowId: a.windowId, scope: 'window' });
    await sleep(300);
    url = await mcp.call('get_url');
    check(url.includes('/A'), 'granting again in A brings the agent back to A', url);

    console.log('\nSeveral agents asking at once, in one browser');
    // Separate homes, so each has its own server id and each needs its own approval.
    const homes = [mkdtempSync(join(tmpdir(), 'onbridge-home-')), mkdtempSync(join(tmpdir(), 'onbridge-home-'))];
    const extra = homes.map((h) => startMcp(h));
    try {
      await a.send({ type: 'arm_pairing' });
      await b.send({ type: 'set_control_mode', enabled: false }); // only A is being asked here
      for (const m of extra) await m.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'second-agent', version: '1' } });
      const calls = extra.map((m) => m.call('get_url'));
      let pending = [];
      for (let i = 0; i < 120 && pending.length < 2; i++) {
        pending = (await a.status())?.pairRequests ?? [];
        if (pending.length < 2) await sleep(250);
      }
      check(pending.length === 2, 'both requests wait side by side; neither cancels the other', `${pending.length} waiting`);
      if (pending.length === 2) {
        const [keep, drop] = pending;
        await a.send({ type: 'resolve_pairing', allow: false, port: drop.port });
        await sleep(300);
        const left = (await a.status())?.pairRequests ?? [];
        check(left.length === 1 && left[0].port === keep.port, 'denying one leaves the other waiting', JSON.stringify(left.map((x) => x.port)));
        // One click: Allow in A's panel also gives the agent A's window. A's main agent lets go first, so the grant does not overlap.
        await a.send({ type: 'hold_session', id: sa.id });
        await a.send({ type: 'resolve_pairing', allow: true, port: keep.port, windowId: a.windowId, scope: 'window' });
        let kept = null;
        for (let i = 0; i < 40 && !kept; i++) {
          kept = ((await a.status())?.sessions ?? []).find((x) => x.port === keep.port && (x.status === 'on_hold' || x.status === 'active'));
          if (!kept) await sleep(250);
        }
        check(Boolean(kept), 'the one the user allowed is connected');
        let active = null;
        for (let i = 0; i < 20 && !active; i++) {
          active = ((await a.status())?.sessions ?? []).find((x) => x.port === keep.port && x.status === 'active');
          if (!active) await sleep(250);
        }
        check(Boolean(active), 'allowing it also gave it control of that window: one click, not two', `${kept?.status}`);
        const keeper = extra.find((m) => m.log().includes(`listening on 127.0.0.1:${keep.port}`));
        const keptUrl = await keeper.call('get_url');
        check(keptUrl.includes('/A'), 'and it can act there straight away', keptUrl);

        // get_url on a page Chrome keeps extensions out of.
        const chromePage = await a.ctx.newPage();
        await chromePage.goto('chrome://version');
        await chromePage.bringToFront();
        await sleep(300);
        const chromeUrl = await keeper.call('get_url');
        check(chromeUrl.includes('chrome://version'), "get_url works on Chrome's own pages", chromeUrl);
        await chromePage.close();
        const dropped = ((await a.status())?.sessions ?? []).find((x) => x.port === drop.port);
        check(dropped?.status === 'failed' && /denied/.test(dropped?.detail ?? ''), 'the one the user denied is not', `${dropped?.status} ${dropped?.detail}`);
      }
      await Promise.allSettled(calls);
    } finally {
      for (const m of extra) m.proc.kill();
      for (const h of homes) rmSync(h, { recursive: true, force: true });
    }

    for (const x of [a, b]) {
      const errs = await x.errors();
      check(errs.length === 0, `browser ${x.label}'s extension logged no errors, including ones Chrome logs itself`, errs.slice(0, 3).join(' | '));
    }

    const status = await mcp.call('bridge_status');
    check(/CONNECTED .*v\d+\.\d+\.\d+/.test(status), 'bridge_status reports the extension version', status.split('\n')[0]);
  } finally {
    for (const x of browsers) {
      x.chromeLog.close();
      await x.ctx.close().catch(() => {});
      rmSync(x.profile, { recursive: true, force: true });
    }
    mcp.proc.kill();
    pageA.srv.close();
    pageB.srv.close();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
