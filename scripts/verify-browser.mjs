/**
 * Real-browser verification of M3 (trusted input) end to end:
 * MCP stdio -> encrypted bridge -> extension -> CDP -> page.
 *
 * Loads the built extension into a real Chrome, pairs it, then asserts the page
 * actually observed trusted events.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = join(ROOT, 'packages/extension/.output/chrome-mv3');

const PAGE = `<!doctype html><html><body>
<h1>onbridge trusted input test</h1>
<button id="btn">Click me</button>
<input id="inp" placeholder="type here">
<script>
  window.__pageSecret = 'main-world-visible';
  window.__log = [];
  btn.addEventListener('click', e => __log.push({t:'click', trusted:e.isTrusted}));
  inp.addEventListener('keydown', e => __log.push({t:'keydown', trusted:e.isTrusted, key:e.key}));
  inp.addEventListener('input', e => __log.push({t:'input', trusted:e.isTrusted, value:e.target.value}));
</script></body></html>`;

const results = [];
const ok = (n, d = '') => { results.push(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { results.push(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };

async function main() {
  if (!existsSync(join(EXT, 'manifest.json'))) {
    console.error(`No built extension at ${EXT}\nRun ./app.sh --build first.`);
    process.exit(2);
  }

  // ── static test page ────────────────────────────────────────────────
  const http = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => http.listen(8931, '127.0.0.1', r));
  const PAGE_URL = 'http://127.0.0.1:8931/';

  // ── MCP server ──────────────────────────────────────────────────────
  const home = mkdtempSync(join(tmpdir(), 'onbridge-browser-'));
  const srv = spawn('node', [join(ROOT, 'packages/mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ONBRIDGE_HOME: home, ONBRIDGE_AGENT_NAME: 'Verify Bot' },
  });
  srv.stderr.on('data', (d) => process.env.V && process.stderr.write(`[srv] ${d}`));

  let buf = '';
  const waiters = new Map();
  srv.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      try { const m = JSON.parse(l); waiters.get(m.id)?.(m); waiters.delete(m.id); } catch {}
    }
  });
  let id = 1;
  const rpc = (method, params = {}) => new Promise((res, rej) => {
    const i = id++;
    waiters.set(i, res);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    setTimeout(() => waiters.delete(i) && rej(new Error(`${method} timeout`)), 30000);
  });
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  const textOf = (r) => (r.result?.content ?? []).map((c) => c.text ?? '').join('\n');

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } });

  // ── Chrome with the extension ───────────────────────────────────────
  const profile = mkdtempSync(join(tmpdir(), 'onbridge-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
        headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  // MV3 service workers are lazy, so there may be no 'serviceworker' event yet.
  // For an unpacked extension Chrome derives the id from the absolute path:
  // sha256(path), first 16 bytes, each nibble mapped onto a-p.
  const { createHash } = await import('node:crypto');
  const extId = createHash('sha256')
    .update(EXT)
    .digest('hex')
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
  console.log('extension id:', extId);

  const page = await ctx.newPage();
  await page.goto(PAGE_URL);

  // The side panel served as a normal tab is a full extension page, so it can
  // talk to the background — this is how we drive pairing without a human.
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  const send = (msg) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);

  await send({ type: 'set_scope', scope: 'all_tabs' });
  await send({ type: 'set_control_mode', enabled: true });

  // ── pairing ─────────────────────────────────────────────────────────
  let paired = false;
  let promptSeen = false;
  for (let i = 0; i < 40; i++) {
    const st = await send({ type: 'get_status' });
    if (st?.pairRequest && !promptSeen) {
      promptSeen = true;
      st.pairRequest.agentName === 'Verify Bot'
        ? ok('pairing prompt names the requesting agent')
        : bad('pairing prompt names the agent', st.pairRequest.agentName);
      await send({ type: 'resolve_pairing', allow: true });
    }
    if (st?.connected) { paired = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!promptSeen) bad('pairing was requested', 'connected without ever prompting');
  paired ? ok('extension paired and connected over encrypted channel') : bad('extension paired', 'never connected');

  if (paired) {
    await page.bringToFront();

    // ── snapshot ──────────────────────────────────────────────────────
    const snap = await call('snapshot', {});
    const snapText = textOf(snap);
    snapText.includes('untrusted-page-content')
      ? ok('page content arrives fenced as untrusted')
      : bad('page content fenced', 'no delimiter');

    const btnRef = /\[button:(\d+)\]/.exec(snapText)?.[1];
    const inpRef = /\[textbox:(\d+)\]/.exec(snapText)?.[1];
    if (!btnRef || !inpRef) {
      bad('snapshot exposes button and textbox refs', snapText.slice(0, 300));
    } else {
      ok('snapshot exposes button and textbox refs');

      // ── THE claim: clicks are real ────────────────────────────────
      await call('click', { ref: Number(btnRef) });
      await page.waitForTimeout(300);
      const clickLog = (await page.evaluate(() => window.__log)).filter((e) => e.t === 'click');
      clickLog.length === 0
        ? bad('click reaches the page', 'no click event observed')
        : clickLog[0].trusted
          ? ok('click is a TRUSTED event (isTrusted: true)')
          : bad('click is trusted', 'isTrusted was false — synthetic fallback');

      // ── typing correctness ────────────────────────────────────────
      await call('type', { ref: Number(inpRef), text: 'hello world', clear: true });
      await page.waitForTimeout(400);
      const value = await page.evaluate(() => document.getElementById('inp').value);
      value === 'hello world'
        ? ok('typed text lands correctly', `"${value}"`)
        : bad('typed text correct', `got "${value}"`);

      const typed = (await page.evaluate(() => window.__log)).filter((e) => e.t === 'input');
      typed.length && typed.every((e) => e.trusted)
        ? ok('input events are trusted')
        : bad('input events trusted', JSON.stringify(typed.slice(0, 3)));
    }

    // ── main-world evaluate ─────────────────────────────────────────
    const ev = await call('evaluate', { script: 'return window.__pageSecret' });
    textOf(ev).includes('main-world-visible')
      ? ok('evaluate runs in the MAIN world (sees page globals)')
      : bad('evaluate sees page globals', textOf(ev).slice(0, 120));

    // ── full-page screenshot honours its params ─────────────────────
    const shot = await call('screenshot', { fullPage: true, quality: 40 });
    const img = (shot.result?.content ?? []).find((c) => c.type === 'image');
    img?.data?.length > 1000
      ? ok('screenshot returns image data', `${Math.round(img.data.length / 1024)}kb`)
      : bad('screenshot returns image data');

    // ── ask_user round trip through the real panel ──────────────────
    const askPromise = call('ask_user', { question: 'Proceed?', options: ['yes', 'no'] });
    await page.waitForTimeout(600);
    const st = await send({ type: 'get_status' });
    if (st?.askRequest?.question === 'Proceed?') {
      ok('ask_user surfaces in the panel');
      await send({ type: 'send_user_message', text: 'yes, go ahead' });
      const answer = textOf(await askPromise);
      answer.includes('yes, go ahead')
        ? ok('ask_user returns the answer to the agent')
        : bad('ask_user returns answer', answer.slice(0, 120));
    } else {
      bad('ask_user surfaces in the panel', JSON.stringify(st?.askRequest));
      await askPromise.catch(() => {});
    }
  }

  await ctx.close();
  srv.kill();
  http.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });

  console.log('\n' + results.join('\n'));
  const failed = results.filter((r) => r.includes('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
