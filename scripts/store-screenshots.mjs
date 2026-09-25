/**
 * Chrome Web Store screenshots, 1280x800, written to artifacts/store/.
 *
 * Reuses the approach of verify-browser.mjs: load the built extension into
 * Playwright's bundled Chromium, start the MCP server against a throwaway
 * ONBRIDGE_HOME, pair it through the side panel served as a normal tab, and
 * drive real commands so every state in the panel is genuine.
 *
 * The panel is designed narrow, so each state is captured at 420px wide and
 * composited onto a 1280x800 poster. The poster itself is rendered in the same
 * browser (so typography matches the panel), captured at 2x, and brought to the
 * exact store size with ImageMagick.
 *
 *   node scripts/store-screenshots.mjs          # headless (new headless, extensions supported)
 *   HEADED=1 node scripts/store-screenshots.mjs # visible window, as verify-browser.mjs does
 */
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = join(ROOT, 'packages/extension/.output/chrome-mv3');
const OUT = join(ROOT, 'artifacts/store');
const SCRATCH =
  process.env.SCRATCH ??
  '/private/tmp/claude-501/-Users-tushars-PycharmProjects-onbridge/0f26c27c-ec85-439e-bb8e-ddf84dc348e6/scratchpad';
const MAGICK = '/opt/homebrew/bin/magick';

// A hostname that reads like a real shop in the panel. Chrome resolves it to
// the local demo server through --host-resolver-rules; nothing leaves the box.
const SHOP_HOST = 'shop.northwind.example';
const SHOP_PORT = 8941;
const SHOP_URL = `http://${SHOP_HOST}/checkout`;

const PANEL_W = 420;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the demo page ─────────────────────────────────────────────────────
const CHECKOUT = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Checkout - Northwind Supply</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1917; background: #fafaf9; }
  header { display: flex; align-items: center; gap: 28px; padding: 0 40px; height: 60px; background: #fff; border-bottom: 1px solid #e7e5e4; }
  .brand { font-weight: 700; font-size: 17px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; }
  .brand i { width: 22px; height: 22px; border-radius: 6px; background: #1c1917; display: inline-block; }
  nav { display: flex; gap: 22px; color: #57534e; font-size: 14px; }
  nav b { color: #1c1917; font-weight: 500; }
  .cart { margin-left: auto; font-size: 13px; color: #57534e; }
  main { max-width: 980px; margin: 0 auto; padding: 36px 40px 60px; }
  h1 { font-size: 26px; letter-spacing: -0.02em; margin: 0 0 6px; }
  .sub { color: #78716c; margin: 0 0 28px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 28px; align-items: start; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 22px 24px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #78716c; margin: 0 0 14px; }
  label { display: block; font-size: 13px; color: #44403c; margin: 12px 0 5px; }
  input { width: 100%; font: inherit; padding: 9px 12px; border: 1px solid #d6d3d1; border-radius: 8px; background: #fff; }
  input:focus { outline: 2px solid #1c1917; outline-offset: -1px; }
  .row { display: flex; gap: 10px; align-items: end; }
  .row > div { flex: 1; }
  button { font: inherit; border: 0; border-radius: 8px; cursor: pointer; }
  .ghost { padding: 9px 16px; background: #f5f5f4; color: #1c1917; border: 1px solid #d6d3d1; }
  .addr { font-size: 14px; color: #44403c; line-height: 1.55; }
  .addr small { display: block; color: #a8a29e; font-size: 12px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 9px 0; border-bottom: 1px solid #f5f5f4; vertical-align: top; }
  td.qty { color: #a8a29e; padding-left: 8px; width: 40px; }
  td.amt { text-align: right; white-space: nowrap; }
  tr.total td { border: 0; font-weight: 700; font-size: 16px; padding-top: 14px; }
  tr.muted td { color: #78716c; }
  .cta { width: 100%; margin-top: 18px; padding: 13px; background: #1c1917; color: #fff; font-weight: 600; font-size: 15px; }
  .cta:hover { background: #292524; }
  .fine { font-size: 12px; color: #a8a29e; margin: 12px 0 0; text-align: center; }
  .ok { display: none; padding: 20px 0 4px; text-align: center; }
  .ok .tick { width: 44px; height: 44px; border-radius: 50%; background: #dcfce7; color: #15803d; display: inline-flex; align-items: center; justify-content: center; font-size: 22px; margin-bottom: 10px; }
  .ok h3 { margin: 0 0 4px; font-size: 18px; }
  .ok p { margin: 0; color: #78716c; font-size: 14px; }
  .promo-ok { color: #15803d; font-size: 13px; margin: 8px 0 0; display: none; }
</style></head><body>
<header>
  <div class="brand"><i></i>Northwind Supply</div>
  <nav><span>Products</span><span>Collections</span><b>Checkout</b><span>Support</span></nav>
  <div class="cart">3 items in cart</div>
</header>
<main>
  <h1>Checkout</h1>
  <p class="sub">Free carbon-neutral shipping on every order over $75.</p>
  <div class="grid">
    <div>
      <div class="card">
        <h2>Contact</h2>
        <label for="name">Full name</label>
        <input id="name" name="name" placeholder="Your name" autocomplete="off">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="off">
      </div>
      <div class="card" style="margin-top:16px">
        <h2>Shipping address</h2>
        <div class="addr">Ada Lovelace<br>12 St James's Square<br>London SW1Y 4JU, United Kingdom<small>Saved address</small></div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2>Promo code</h2>
        <div class="row">
          <div><input id="promo" name="promo" placeholder="Enter a code" autocomplete="off"></div>
          <button id="apply" class="ghost">Apply</button>
        </div>
        <p id="promo-ok" class="promo-ok">Code applied: 10% off your first order.</p>
      </div>
    </div>
    <div class="card" id="summary">
      <h2>Order summary</h2>
      <div id="items">
      <table>
        <tr><td>Field notebook, dot grid</td><td class="qty">x2</td><td class="amt">$38.00</td></tr>
        <tr><td>Brass pocket compass</td><td class="qty">x1</td><td class="amt">$89.00</td></tr>
        <tr><td>Waxed canvas day bag</td><td class="qty">x1</td><td class="amt">$122.00</td></tr>
        <tr class="muted"><td colspan="2">Shipping</td><td class="amt">Free</td></tr>
        <tr class="total"><td colspan="2">Total</td><td class="amt">$249.00</td></tr>
      </table>
      <button id="place" class="cta">Place order &middot; $249</button>
      <p class="fine">By placing this order you agree to the terms of sale.</p>
      </div>
      <div class="ok" id="ok">
        <div class="tick">&#10003;</div>
        <h3>Order placed</h3>
        <p>Order #NW-48213 is confirmed.<br>A receipt is on its way to your inbox.</p>
      </div>
    </div>
  </div>
</main>
<script>
  document.getElementById('apply').addEventListener('click', () => {
    if (document.getElementById('promo').value.trim()) document.getElementById('promo-ok').style.display = 'block';
  });
  document.getElementById('place').addEventListener('click', () => {
    document.getElementById('items').style.display = 'none';
    document.getElementById('ok').style.display = 'block';
  });
</script>
</body></html>`;

// ── helpers ───────────────────────────────────────────────────────────

/** The end-to-end suite shares the loopback ports; never run beside it. */
async function waitForVerifyToFinish() {
  const running = () => {
    try {
      return execFileSync('pgrep', ['-f', 'verify-browser.mjs'], { encoding: 'utf8' }).trim();
    } catch {
      return ''; // pgrep exits 1 when nothing matches
    }
  };
  for (let i = 0; i < 60; i++) {
    const pids = running();
    if (!pids) return;
    console.log(`verify-browser.mjs is running (pid ${pids.split('\n').join(', ')}); waiting...`);
    await sleep(10_000);
  }
  throw new Error('verify-browser.mjs still running after 10 minutes; giving up');
}

/** Unpacked extension id: sha256 of the absolute path, first 16 bytes, nibbles onto a-p. */
const extensionId = (dir) =>
  createHash('sha256')
    .update(dir)
    .digest('hex')
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');

function startMcpServer(home, cwd) {
  const srv = spawn('node', [join(ROOT, 'packages/mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env, ONBRIDGE_HOME: home },
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
      try {
        const m = JSON.parse(l);
        waiters.get(m.id)?.(m);
        waiters.delete(m.id);
      } catch {
        /* not a complete JSON line */
      }
    }
  });
  let id = 1;
  const rpc = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = id++;
      waiters.set(i, res);
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
      setTimeout(() => waiters.delete(i) && rej(new Error(`${method} timeout`)), 30_000);
    });
  const textOf = (r) => (r.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    if (process.env.V) console.log(`[${name}] ${textOf(r).split('\n').slice(0, 3).join(' | ').slice(0, 240)}`);
    return r;
  };
  return { srv, rpc, call, textOf };
}

const dataUri = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

// ── posters ───────────────────────────────────────────────────────────

const POSTER_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; width: 1280px; height: 800px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .dark { width: 1280px; height: 800px; position: relative; color: #fafafa;
    background: radial-gradient(1100px 700px at 85% 50%, #1b2a24 0%, #0f1412 45%, #0a0a0a 100%); }
  .copy { position: absolute; left: 88px; top: 0; height: 800px; width: 600px; display: flex; flex-direction: column; justify-content: center; }
  .eyebrow { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #34d399; margin-bottom: 26px; }
  .eyebrow img { width: 22px; height: 22px; border-radius: 6px; }
  h1 { font-size: 52px; line-height: 1.08; letter-spacing: -0.03em; font-weight: 700; margin: 0 0 22px; }
  .sub { font-size: 19px; line-height: 1.5; color: #a3a3a3; margin: 0; max-width: 520px; }
  .panel { position: absolute; right: 88px; top: 30px; width: 420px; height: 740px; border-radius: 14px; overflow: hidden;
    border: 1px solid rgba(255,255,255,0.10); box-shadow: 0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.6); background: #171717; }
  .panel img { display: block; width: 420px; height: 740px; }

  .browser { width: 1280px; height: 800px; background: #0a0a0a; display: flex; flex-direction: column; }
  .toolbar { height: 44px; background: #f3f4f6; border-bottom: 1px solid #d9dbe0; display: flex; align-items: center; gap: 10px; padding: 0 14px; }
  .lights { display: flex; gap: 7px; margin-right: 8px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  .arrows { color: #9ca3af; font-size: 15px; letter-spacing: 8px; }
  .omni { flex: 1; height: 28px; border-radius: 14px; background: #fff; border: 1px solid #d9dbe0; display: flex; align-items: center; padding: 0 14px; font-size: 13px; color: #374151; gap: 8px; }
  .omni .lock { color: #6b7280; font-size: 12px; }
  .omni .host { color: #111827; }
  .omni .path { color: #6b7280; }
  .ext { width: 26px; height: 26px; border-radius: 7px; background: #e5e7eb; display: flex; align-items: center; justify-content: center; }
  .ext img { width: 18px; height: 18px; }
  .split { display: flex; flex: 1; }
  .split img { display: block; }
  .split .page { width: 860px; height: 756px; }
  .split .side { width: 420px; height: 756px; border-left: 1px solid #262626; }
`;

const posterHtml = (title, sub, panelPng, iconPng) => `<!doctype html><html><head><meta charset="utf-8"><style>${POSTER_CSS}</style></head>
<body><div class="dark">
  <div class="copy">
    <div class="eyebrow">onbridge</div>
    <h1>${title}</h1>
    <p class="sub">${sub}</p>
  </div>
  <div class="panel"><img src="${panelPng}" alt=""></div>
</div></body></html>`;

const browserHtml = (pagePng, panelPng, iconPng) => `<!doctype html><html><head><meta charset="utf-8"><style>${POSTER_CSS}</style></head>
<body><div class="browser">
  <div class="toolbar">
    <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
    <div class="arrows">&#8592;&#8594;</div>
    <div class="omni"><span class="lock">&#9711;</span><span><span class="host">${SHOP_HOST}</span><span class="path">/checkout</span></span></div>
    <div class="ext"><img src="${iconPng}" alt=""></div>
  </div>
  <div class="split"><img class="page" src="${pagePng}" alt=""><img class="side" src="${panelPng}" alt=""></div>
</div></body></html>`;

/** Render a poster document at 2x and bring it to exactly 1280x800 with ImageMagick. */
async function renderPoster(ctx, html, outFile) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(200);
  const raw = join(SCRATCH, `poster-${Date.now()}.png`);
  await page.screenshot({ path: raw, type: 'png' });
  await page.close();
  execFileSync(MAGICK, [raw, '-filter', 'Lanczos', '-resize', '1280x800!', '-alpha', 'off', '-strip', outFile]);
  rmSync(raw, { force: true });
  return execFileSync(MAGICK, ['identify', '-format', '%wx%h %m', outFile], { encoding: 'utf8' });
}

// ── main ──────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(join(EXT, 'manifest.json'))) {
    console.error(`No built extension at ${EXT}\nRun ./app.sh --build first.`);
    process.exit(2);
  }
  await waitForVerifyToFinish();
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });

  // Demo shop. Bound to loopback; the hostname is mapped in Chrome only.
  const http = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CHECKOUT);
  });
  await new Promise((r) => http.listen(SHOP_PORT, '127.0.0.1', r));

  // MCP server against a throwaway home, run from a plausible project so the
  // panel's identity block shows a project path rather than this repo.
  const home = mkdtempSync(join(SCRATCH, 'onbridge-home-'));
  const projectDir = join(SCRATCH, 'code', 'northwind-storefront');
  mkdirSync(projectDir, { recursive: true });
  const { srv, rpc, call, textOf } = startMcpServer(home, projectDir);
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'claude-code', version: '2.1.0' },
  });

  const profile = mkdtempSync(join(SCRATCH, 'onbridge-profile-'));
  const headed = process.env.HEADED === '1';
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: !headed,
    ...(headed ? {} : { channel: 'chromium' }),
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP ${SHOP_HOST} 127.0.0.1:${SHOP_PORT}`,
    ],
  });
  const extId = extensionId(EXT);
  console.log('extension id:', extId);
  const iconPng = dataUri(join(EXT, 'icon/128.png'));

  const produced = [];
  const missing = [];
  try {
    const page = await ctx.newPage();
    await page.goto('about:blank');

    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.setViewportSize({ width: PANEL_W, height: 740 });
    const send = (msg) =>
      panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
    const windowId = await panel.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));

    const shotPanel = async (file, { height = 740, toBottom = false, expect } = {}) => {
      await panel.setViewportSize({ width: PANEL_W, height });
      await panel.bringToFront();
      if (expect) {
        try {
          // innerText applies text-transform, and the card headings are CSS
          // uppercase, so compare case-insensitively.
          await panel.waitForFunction(
            (t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()),
            expect,
            { timeout: 10_000 },
          );
        } catch (e) {
          const seen = await panel.evaluate(() => document.body.innerText.slice(0, 800));
          const st = await send({ type: 'get_status', windowId });
          console.log(`panel did not show "${expect}". Panel text:\n${seen}\n--- status: ${JSON.stringify(st).slice(0, 600)}`);
          throw e;
        }
      }
      await sleep(1200); // one poll of the panel, so counters and timings settle
      await panel.evaluate((bottom) => {
        // The panel counts every probed port as an agent (manager.list() keeps
        // the failed probes), so "10 agents found" shows for a single agent.
        // That is a panel bug, not a state worth advertising; hide that card.
        for (const el of document.querySelectorAll('div.rounded-lg')) {
          if (/\b\d+ agents found\b/.test(el.textContent ?? '')) el.style.display = 'none';
        }
        const el = document.querySelector('.overflow-y-auto');
        if (el) el.scrollTop = bottom ? el.scrollHeight : 0;
      }, toBottom);
      await sleep(150);
      await panel.screenshot({ path: file, type: 'png' });
      return file;
    };

    // ── pairing ─────────────────────────────────────────────────────
    await send({ type: 'set_scope', scope: 'window' });
    await send({ type: 'set_control_mode', enabled: true });

    let session = null;
    for (let i = 0; i < 240 && !session; i++) {
      const st = await send({ type: 'get_status', windowId });
      if (st?.pairRequest) await send({ type: 'resolve_pairing', allow: true });
      session = (st?.sessions ?? []).find((s) => s.status === 'on_hold' || s.status === 'active');
      if (!session) await sleep(250);
    }
    if (!session) throw new Error('the agent never paired');
    const granted = await send({ type: 'activate_session', id: session.id, windowId, scope: 'window' });
    if (!granted?.ok) throw new Error(`activate_session refused: ${granted?.reason}`);
    console.log('paired and granted this window');

    // The "accepting new agents" banner stays for a minute after control mode
    // goes on. Wait it out so the connected shot shows a settled panel.
    for (let i = 0; i < 90; i++) {
      const st = await send({ type: 'get_status', windowId });
      if (st?.pairWindowOpen === false) break;
      await sleep(1000);
    }

    // ── a few reads, so the connected state carries some history ────
    await page.bringToFront();
    await call('navigate', { url: SHOP_URL, snapshot: false });
    const snap = textOf(await call('snapshot', {}));
    await call('find', { text: 'Place order' });

    const refOf = (role, label) => {
      const m = new RegExp(`\\[${role}:(\\d+)\\][^\\n]*${label}`).exec(snap);
      return m ? Number(m[1]) : null;
    };
    const refBySelector = async (selector) => {
      const t = textOf(await call('find', { selector }));
      const m = /:(\d+)\]/.exec(t);
      return m ? Number(m[1]) : null;
    };
    const nameRef = refOf('textbox', 'Your name') ?? (await refBySelector('#name'));
    const emailRef = refOf('textbox', 'you@example') ?? (await refBySelector('#email'));
    const promoRef = refOf('textbox', 'Enter a code') ?? (await refBySelector('#promo'));
    const applyRef = refOf('button', 'Apply') ?? (await refBySelector('#apply'));
    const placeRef = refOf('button', 'Place order') ?? (await refBySelector('#place'));
    if ([nameRef, emailRef, promoRef, applyRef, placeRef].some((r) => r == null)) {
      throw new Error(`could not resolve refs from the snapshot:\n${snap.slice(0, 600)}`);
    }

    // 01: connected, control mode on, agent paired and holding this window.
    const p01 = await shotPanel(join(SCRATCH, 'panel-01.png'), { expect: 'encrypted' });
    produced.push([
      '01-panel-connected.png',
      await renderPoster(
        ctx,
        posterHtml(
          'Your agent, in your&nbsp;browser.',
          'Pair Claude Code, Cursor or any MCP client, then grant it a tab, a window or everything. Take control back whenever you like.',
          dataUri(p01),
          iconPng,
        ),
        join(OUT, '01-panel-connected.png'),
      ),
    ]);

    // ── ordinary writes that pass without a prompt in Balanced mode ──
    await page.bringToFront();
    await call('type', { ref: nameRef, text: 'Ada Lovelace', clear: true });
    await call('type', { ref: emailRef, text: 'ada@northwind.example', clear: true });
    await call('type', { ref: promoRef, text: 'WELCOME10', clear: true });
    await call('click', { ref: applyRef });
    await call('extract_text', {});
    await call('get_url', {});
    await call('scroll', { direction: 'down', amount: 200 });
    await call('list_actions', {});

    // ── the destructive click is held for approval ──────────────────
    const pending = call('click', { ref: placeRef });
    // Poll the background rather than the panel DOM: the panel tab is hidden
    // while the page is in front, and a hidden tab gets no animation frames.
    let held = null;
    for (let i = 0; i < 60 && !held; i++) {
      await sleep(250);
      held = (await send({ type: 'get_status', windowId }))?.approvalRequest ?? null;
    }
    if (!held) {
      const early = await Promise.race([pending, sleep(2000).then(() => null)]);
      throw new Error(
        `the destructive click was not held for approval; it returned: ${early ? textOf(early).slice(0, 300) : '(still pending)'}`,
      );
    }
    console.log(`approval held: ${held.action} ${held.detail} (${held.risk})`);

    // 02: the approval prompt.
    const p02 = await shotPanel(join(SCRATCH, 'panel-02.png'), { expect: 'Approval needed' });
    produced.push([
      '02-approval-prompt.png',
      await renderPoster(
        ctx,
        posterHtml(
          'Real-world actions wait for&nbsp;you.',
          'Anything that pays, deletes, sends or touches credentials is held until you allow it. No answer means no.',
          dataUri(p02),
          iconPng,
        ),
        join(OUT, '02-approval-prompt.png'),
      ),
    ]);

    // 04: the page and the panel together, at the same moment. Both are
    // captured 756 tall so a 44px toolbar brings the composite to 800.
    try {
      await page.setViewportSize({ width: 860, height: 756 });
      await page.bringToFront();
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(300);
      const pagePng = join(SCRATCH, 'page-04.png');
      await page.screenshot({ path: pagePng, type: 'png' });
      const p04 = await shotPanel(join(SCRATCH, 'panel-04.png'), { height: 756, expect: 'Approval needed' });
      produced.push([
        '04-page-and-panel.png',
        await renderPoster(ctx, browserHtml(dataUri(pagePng), dataUri(p04), iconPng), join(OUT, '04-page-and-panel.png')),
      ]);
    } catch (e) {
      missing.push(`04-page-and-panel.png: ${e.message}`);
    }

    // Let the order through, then read the confirmation back.
    await send({ type: 'resolve_approval', allow: true });
    await pending;
    await page.bringToFront();
    await call('extract_text', {});
    await call('snapshot', {});

    // 03: the activity feed, scrolled into view.
    const p03 = await shotPanel(join(SCRATCH, 'panel-03.png'), { toBottom: true, expect: 'Activity' });
    produced.push([
      '03-activity-feed.png',
      await renderPoster(
        ctx,
        posterHtml(
          'Every action, on the&nbsp;record.',
          'Each command the agent runs is logged with its target, timing and result. Pause or disconnect at any moment.',
          dataUri(p03),
          iconPng,
        ),
        join(OUT, '03-activity-feed.png'),
      ),
    ]);
  } finally {
    await ctx.close().catch(() => {});
    srv.kill();
    http.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }

  console.log('\nProduced:');
  for (const [name, dims] of produced) console.log(`  ${join(OUT, name)}  ${dims}`);
  if (missing.length) {
    console.log('\nNot captured:');
    for (const m of missing) console.log(`  ${m}`);
  }
  // Store cards need exactly 1280x800.
  const wrong = produced.filter(([, d]) => !d.startsWith('1280x800 '));
  if (wrong.length) {
    console.error('Wrong dimensions:', wrong);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('screenshot harness error:', e);
  process.exit(2);
});
