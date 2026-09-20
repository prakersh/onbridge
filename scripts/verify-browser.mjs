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

/**
 * Served same-origin at /frame and cross-origin from a second port. A
 * cross-origin iframe is an out-of-process frame, so it is the case that cannot
 * be reached from the parent document by any means other than CDP.
 */
const FRAME = (label) => `<!doctype html><html><body>
<button id="fbtn">Inside the ${label} iframe</button>
<input id="finp" placeholder="frame input">
<script>
  window.__frameSecret = '${label}-main-world';
  window.__frameLog = [];
  fbtn.addEventListener('click', e => __frameLog.push({t:'click', trusted:e.isTrusted}));
  finp.addEventListener('input', e => __frameLog.push({t:'input', trusted:e.isTrusted, value:e.target.value}));
</script></body></html>`;

const PAGE = `<!doctype html><html><body>
<h1>onbridge trusted input test</h1>
<button id="btn">Click me</button>
<button id="danger">Place order &middot; $249</button>
<input id="inp" placeholder="type here">
<a id="xlink" href="http://localhost:8932/frame">Go cross-site</a>
<button id="popbtn" onclick="window.open('http://localhost:8932/frame')">Open cross-site popup</button>

<!-- A same-site link, for the case that broke: a click that navigates. -->
<a id="samelink" href="/next">Go to the next page</a>

<!-- A container that HAS text, reachable only by ref. tabindex is what makes
     it interactive enough to be given one, the same way a real results grid
     earns one from a jsaction or a pointer cursor. -->
<div id="results" tabindex="0">
  <div class="row"><span>Widget A</span> <span>Rs 2,400</span></div>
  <div class="row"><span>Widget B</span> <span>Rs 3,100</span></div>
</div>

<!-- A container that genuinely has none. Must read differently from the above. -->
<div id="emptybox" tabindex="0"></div>

<!-- Text that lives in a shadow root: the walker used to miss content like
     this and report the element as empty. -->
<my-article></my-article>

<!-- The three href forms an agent will meet. A relative one must come back
     resolved (a relative URL handed to navigate goes nowhere), an absolute one
     unchanged, and a javascript: target must report as having no destination
     rather than tempting a navigate to it. -->
<a class="result" href="/next?id=1">Result one</a>
<a class="result" href="http://127.0.0.1:8931/next?id=2">Result two</a>
<a class="result" href="javascript:void(0)">Result three</a>

<my-widget></my-widget>
<iframe id="frame" src="/frame" width="300" height="140"></iframe>
<iframe id="xframe" src="http://localhost:8932/frame" width="300" height="140"></iframe>

<table>
  <tr><th>Item</th><th>Price</th></tr>
  <tr><td>Widget</td><td>$249</td></tr>
  <tr><td>Gadget</td><td>$99</td></tr>
</table>

<script>
  // A web component with an OPEN shadow root: its content is invisible to a
  // flat querySelectorAll, which is exactly the gap being tested.
  customElements.define('my-article', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML =
        '<p>Shadow article body about SIP gateways.</p>';
    }
  });
  customElements.define('my-widget', class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="shadowBtn">Shadow button</button>';
      root.getElementById('shadowBtn').addEventListener('click', e => {
        window.__log.push({t:'shadow', trusted:e.isTrusted});
      });
    }
  });
</script>
<script>
  window.__pageSecret = 'main-world-visible';
  window.__log = [];
  btn.addEventListener('click', e => __log.push({t:'click', trusted:e.isTrusted}));
  danger.addEventListener('click', e => __log.push({t:'danger', trusted:e.isTrusted}));
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
  const http = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/frame') return void res.end(FRAME('same-origin'));
    // The destination of the same-site link, so a navigating click has
    // somewhere real to land.
    //
    // Deliberately slow. The bug being guarded against was a fixed 300ms sleep
    // after a click: on a heavy site the navigation committed later than that,
    // the extension concluded nothing had happened, and then failed
    // snapshotting a document that was being torn down. An instant local page
    // would never have caught it.
    if (req.url?.startsWith('/next')) {
      return void setTimeout(
        () =>
          res.end(
            '<!doctype html><html><head><title>Next page</title></head><body>' +
              '<h1>You have arrived</h1><button id="nextbtn">On the next page</button></body></html>',
          ),
        700,
      );
    }
    res.end(PAGE);
  });
  await new Promise((r) => http.listen(8931, '127.0.0.1', r));
  const PAGE_URL = 'http://127.0.0.1:8931/';

  // A different port is a different origin, which is what forces Chrome to put
  // this frame in its own process.
  const xhttp = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FRAME('cross-origin'));
  });
  await new Promise((r) => xhttp.listen(8932, 'localhost', r));

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

  await send({ type: 'set_scope', scope: 'all' });
  await send({ type: 'set_control_mode', enabled: true });

  // ── pairing ─────────────────────────────────────────────────────────
  let paired = false;
  let promptSeen = false;
  let sessionId = null;
  // Dial count for the port that actually paired. The pairing prompt used to
  // share the 3-5s port-probe budget, so the client hung up while the prompt was
  // still on screen, retried, and re-prompted — a connect/disconnect storm. A
  // clean first pairing is exactly one dial, however long the human takes.
  let pairedAttempts = 0;
  for (let i = 0; i < 60; i++) {
    const st = await send({ type: 'get_status' });
    if (st?.pairRequest && !promptSeen) {
      promptSeen = true;
      const agent = st.pairRequest.agent;
      agent?.name === 'Verify Bot'
        ? ok('pairing prompt names the requesting agent')
        : bad('pairing prompt names the agent', JSON.stringify(agent));
      agent?.pid > 0 && agent?.cwd
        ? ok('pairing prompt identifies the agent process and project')
        : bad('pairing prompt shows pid and cwd', JSON.stringify(agent));

      // Deliberately slow. A human reading the prompt takes seconds, and the
      // client must not give up while they do.
      await new Promise((r) => setTimeout(r, 6000));
      await send({ type: 'resolve_pairing', allow: true });
    }
    const onHold = (st?.sessions ?? []).find((s) => s.status === 'on_hold' || s.status === 'active');
    if (onHold) {
      paired = true;
      sessionId = onHold.id;
      pairedAttempts = onHold.attempts;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!promptSeen) bad('pairing was requested', 'connected without ever prompting');
  paired
    ? ok('extension paired over encrypted channel after a slow human approval')
    : bad('extension paired', 'never connected');

  pairedAttempts === 1
    ? ok('a slow human approval takes exactly one connection attempt')
    : bad('pairing is a single clean connect', `${pairedAttempts} dials to the paired port`);

  // ── an authenticated agent controls nothing until granted ───────────
  if (paired) {
    const held = await call('get_url', {});
    /has not been given control|not been given/i.test(textOf(held))
      ? ok('a connected agent with no grant is refused, with an actionable reason')
      : bad('agent on hold is refused', textOf(held).slice(0, 200));

    const granted = await send({
      type: 'activate_session',
      id: sessionId,
      scope: 'all',
    });
    granted?.ok ? ok('user can hand a held agent control') : bad('activate session', granted?.reason);
  }

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

    // ── shadow DOM ───────────────────────────────────────────────────
    const shadowRef = /\[button:(\d+)\][^\n]*Shadow button/.exec(snapText)?.[1];
    if (!shadowRef) {
      bad('shadow DOM content appears in the snapshot');
    } else {
      ok('shadow DOM content appears in the snapshot');
      await call('click', { ref: Number(shadowRef) });
      await page.waitForTimeout(300);
      const shadowClicks = (await page.evaluate(() => window.__log)).filter((e) => e.t === 'shadow');
      shadowClicks.length && shadowClicks[0].trusted
        ? ok('element inside a shadow root is clickable with trusted input')
        : bad('shadow element clickable', JSON.stringify(shadowClicks));
    }

    // ── iframes ──────────────────────────────────────────────────────
    // The trust assertion is the point. The old check only asked whether a click
    // registered, which the synthetic fallback also satisfies — so it passed
    // throughout the entire period iframe input was untrusted.
    for (const [label, host] of [['same-origin', '127.0.0.1:8931'], ['cross-origin', 'localhost:8932']]) {
      const re = new RegExp(`\\[button:(\\d+)\\][^\\n]*Inside the ${label} iframe`);
      const m = re.exec(snapText);
      if (!m) {
        bad(`${label} iframe content appears in the snapshot`);
        continue;
      }
      ok(`${label} iframe content appears in the snapshot`);
      const bref = Number(m[1]);
      // The frame's own input is the first textbox after its button, which keeps
      // the two identically-shaped frames from being confused for each other.
      const inpRef = /\[textbox:(\d+)\]/.exec(snapText.slice(m.index))?.[1];

      const frameEl = page.frames().find((f) => f.url() === `http://${host}/frame`);
      if (!frameEl) {
        bad(`${label} iframe located`, 'frame not found in the page');
        continue;
      }

      const clickRes = await call('click', { ref: bref });
      await page.waitForTimeout(400);
      const log = await frameEl.evaluate(() => window.__frameLog);
      const click = log.find((e) => e.t === 'click');
      if (!click) {
        bad(`${label} iframe element is clickable`, textOf(clickRes).slice(0, 200));
      } else if (!click.trusted) {
        bad(`${label} iframe click is trusted`, 'isTrusted was false — synthetic fallback');
      } else {
        ok(`${label} iframe click is trusted`);
      }

      // Typing must land in the frame's own input, not the top document's.
      if (inpRef == null) {
        bad(`${label} iframe input found in the snapshot`);
      } else {
        const typeRes = await call('type', { ref: Number(inpRef), text: 'typed' });
        await page.waitForTimeout(400);
        const typed = (await frameEl.evaluate(() => window.__frameLog))
          .filter((e) => e.t === 'input')
          .pop();
        typed?.trusted && typed.value === 'typed'
          ? ok(`${label} iframe accepts trusted typing`)
          : bad(`${label} iframe trusted typing`, JSON.stringify(typed ?? textOf(typeRes).slice(0, 160)));
      }

      // evaluate must run in THAT frame's main world — reading a page global is
      // the only way to tell a real main-world context from an isolated one.
      // It is a sensitive action, so it gates on approval like any other.
      const evP = call('evaluate', { ref: bref, script: 'return window.__frameSecret' });
      await page.waitForTimeout(700);
      await send({ type: 'resolve_approval', allow: true });
      const evText = textOf(await evP);
      evText.includes(`${label}-main-world`)
        ? ok(`${label} iframe evaluate runs in that frame's main world`)
        : bad(`${label} iframe evaluate scope`, evText.slice(0, 160));
    }

    // ── approval modes ───────────────────────────────────────────────
    // The agent must never be able to widen its own permissions.
    const modeTools = (await rpc('tools/list')).result.tools.map((t) => t.name);
    modeTools.some((n) => /policy|approval_mode|permission/i.test(n))
      ? bad('agent cannot change its own approval mode', `exposed: ${modeTools.filter(n => /policy|mode/i.test(n))}`)
      : ok('agent cannot change its own approval mode (no such tool)');

    const statusText = textOf(await call('bridge_status', {}));
    /Approval mode: auto/.test(statusText)
      ? ok('bridge_status reports the approval mode')
      : bad('bridge_status reports mode', statusText.slice(0, 160));

    // ── approval gate: a destructive click must block ────────────────
    const dangerRef = /\[button:(\d+)\][^\n]*Place order/.exec(snapText)?.[1];
    if (!dangerRef) {
      bad('destructive button present in snapshot');
    } else {
      // DENY path: the click must never reach the page.
      const denied = call('click', { ref: Number(dangerRef) });
      await page.waitForTimeout(700);
      const st1 = await send({ type: 'get_status' });
      if (st1?.approvalRequest?.action === 'click' && st1.approvalRequest.risk === 'destructive') {
        ok('destructive click is held for approval');
      } else {
        bad('destructive click held for approval', JSON.stringify(st1?.approvalRequest));
      }
      await send({ type: 'resolve_approval', allow: false });
      const deniedText = textOf(await denied);

      const firedAfterDeny = (await page.evaluate(() => window.__log)).filter((e) => e.t === 'danger');
      firedAfterDeny.length === 0
        ? ok('denied action never reaches the page')
        : bad('denied action blocked', 'the click went through anyway');

      /declined/i.test(deniedText)
        ? ok('denial is reported back to the agent')
        : bad('denial reported to agent', deniedText.slice(0, 120));

      // ALLOW path: the same click must then succeed.
      const allowed = call('click', { ref: Number(dangerRef) });
      await page.waitForTimeout(700);
      await send({ type: 'resolve_approval', allow: true });
      await allowed;
      await page.waitForTimeout(300);
      const firedAfterAllow = (await page.evaluate(() => window.__log)).filter((e) => e.t === 'danger');
      firedAfterAllow.length === 1 && firedAfterAllow[0].trusted
        ? ok('approved action proceeds as trusted input')
        : bad('approved action proceeds', JSON.stringify(firedAfterAllow));
    }

    // ── extract_text renders tables as markdown ─────────────────────
    const extracted = textOf(await call('extract_text', {}));
    /\|\s*Widget\s*\|/.test(extracted) && /\| --- \|/.test(extracted)
      ? ok('extract_text renders tables as markdown')
      : bad('extract_text table rendering', extracted.slice(0, 200));

    // ── list_actions is a cheap alternative to a snapshot ───────────
    const actions = textOf(await call('list_actions', {}));
    actions.includes('Place order') && actions.length < snapText.length
      ? ok('list_actions lists controls and is smaller than a snapshot')
      : bad('list_actions', `${actions.length} chars vs snapshot ${snapText.length}`);

    // ── console_logs actually returns something now ─────────────────
    await page.evaluate(() => console.warn('onbridge-console-probe'));
    await page.waitForTimeout(300);
    const logs = textOf(await call('console_logs', {}));
    logs.includes('onbridge-console-probe')
      ? ok('console_logs captures page console output')
      : bad('console_logs captures output', logs.slice(0, 200));

    // ── find honours its selector parameter ─────────────────────────
    const bySelector = textOf(await call('find', { selector: '#danger' }));
    bySelector.includes('Place order') && !bySelector.includes('Click me')
      ? ok('find filters by CSS selector')
      : bad('find selector filter', bySelector.slice(0, 200));

    // ── cookie values are withheld by default ───────────────────────
    const cookies = await call('get_cookies', {});
    const cookieText = textOf(cookies);
    !/=\w{6,}/.test(cookieText) || /hidden/.test(cookieText)
      ? ok('cookie values are withheld by default')
      : bad('cookie values withheld', cookieText.slice(0, 160));

    // ── main-world evaluate ─────────────────────────────────────────
    // evaluate is classified sensitive (it runs arbitrary code), so it is gated.
    const evPromise = call('evaluate', { script: 'return window.__pageSecret' });
    await page.waitForTimeout(700);
    const evGate = await send({ type: 'get_status' });
    evGate?.approvalRequest?.action === 'evaluate'
      ? ok('evaluate is gated as a sensitive action')
      : bad('evaluate is gated', JSON.stringify(evGate?.approvalRequest));
    await send({ type: 'resolve_approval', allow: true });

    const ev = await evPromise;
    textOf(ev).includes('main-world-visible')
      ? ok('evaluate runs in the MAIN world (sees page globals)')
      : bad('evaluate sees page globals', textOf(ev).slice(0, 120));

    // ── full-page screenshot honours its params ─────────────────────
    const shot = await call('screenshot', { fullPage: true, quality: 40 });
    const img = (shot.result?.content ?? []).find((c) => c.type === 'image');
    img?.data?.length > 1000
      ? ok('screenshot returns image data', `${Math.round(img.data.length / 1024)}kb`)
      : bad('screenshot returns image data');

    // ── bypass mode actually bypasses ───────────────────────────────
    await send({ type: 'set_approval_mode', mode: 'yolo' });
    const yoloStatus = textOf(await call('bridge_status', {}));
    /Approval mode: yolo/.test(yoloStatus)
      ? ok('bypass mode is reported to the agent')
      : bad('bypass mode reported', yoloStatus.slice(0, 120));

    const beforeYolo = (await page.evaluate(() => window.__log)).filter((e) => e.t === 'danger').length;
    await call('click', { ref: Number(dangerRef) });
    await page.waitForTimeout(500);
    const afterYolo = (await page.evaluate(() => window.__log)).filter((e) => e.t === 'danger').length;
    afterYolo === beforeYolo + 1
      ? ok('bypass mode runs a destructive action without prompting')
      : bad('bypass mode skips prompting', `danger clicks ${beforeYolo} → ${afterYolo}`);

    // Even in bypass, an explicit domain block must still hold.
    await send({ type: 'set_policy', policy: { denylist: ['127.0.0.1'] } });
    const blocked = await call('click', { ref: Number(dangerRef) });
    /Blocked by user policy/.test(textOf(blocked))
      ? ok('bypass mode still honours the domain denylist')
      : bad('bypass honours denylist', textOf(blocked).slice(0, 140));

    // The denylist has to stop the agent *reaching* a site, not merely acting
    // once it is there. Judging `navigate` by the tab's current URL let a
    // blocked page load, run its scripts, and hand its content back — the
    // refusal arrived after everything it was meant to prevent.
    await send({ type: 'set_policy', policy: { denylist: ['localhost'] } });
    const navBlocked = await call('navigate', { url: `http://localhost:8932/frame` });
    /Blocked by user policy/.test(textOf(navBlocked))
      ? ok('denylist blocks navigating to a blocked site')
      : bad('denylist blocks navigation', textOf(navBlocked).slice(0, 140));

    const stillHere = await call('get_url', {});
    !/localhost:/.test(textOf(stillHere))
      ? ok('the blocked navigation never happened')
      : bad('blocked navigation did not happen', textOf(stillHere).slice(0, 140));

    // A click on a link is how a browser usually moves, and the destination is
    // nowhere in the command's parameters. Checking only what the agent names
    // leaves the ordinary path wide open.
    await send({ type: 'set_policy', policy: { denylist: ['localhost'] } });
    const linkSnap = await call('find', { text: 'Go cross-site' });
    const linkRef = /\[link:(\d+)\]/.exec(textOf(linkSnap))?.[1];
    if (linkRef) {
      const clicked = await call('click', { ref: Number(linkRef) });
      /Blocked by user policy/.test(textOf(clicked))
        ? ok('a click that lands on a blocked site is refused')
        : bad('click onto blocked site refused', textOf(clicked).slice(0, 160));

      !/localhost:8932/.test(textOf(clicked))
        ? ok('no content from the blocked page reaches the agent')
        : bad('blocked page content withheld', textOf(clicked).slice(0, 160));

      await page.waitForTimeout(500);
      const back = await call('get_url', {});
      !/localhost:8932/.test(textOf(back))
        ? ok('the tab is sent back off the blocked page')
        : bad('tab returned from blocked page', textOf(back).slice(0, 160));
    } else {
      bad('found the cross-site link', textOf(linkSnap).slice(0, 160));
    }

    // The destination lives inside the script string, invisible to any check on
    // parameters — and in bypass mode evaluate is not gated at all, so this is
    // the path with the least standing between an agent and a blocked site.
    const evalNav = await call('evaluate', {
      script: `location.href = 'http://localhost:8932/frame'; 'went'`,
    });
    /Blocked by user policy/.test(textOf(evalNav))
      ? ok('evaluate assigning location is caught by the domain lists')
      : bad('evaluate location= blocked', textOf(evalNav).slice(0, 160));

    await page.waitForTimeout(500);
    const afterEval = await call('get_url', {});
    !/localhost:8932/.test(textOf(afterEval))
      ? ok('the tab is sent back after an evaluate navigation')
      : bad('tab returned after evaluate nav', textOf(afterEval).slice(0, 160));

    // Reverting an interrupted load can leave the tab on a chrome-error page,
    // which no content script can reach. Restore a known page before continuing.
    await page.goto(PAGE_URL);
    await page.waitForTimeout(300);

    // window.open puts the blocked page in a DIFFERENT tab, so the guard
    // watching this one sees nothing move. Without the opened-tab check the
    // blocked page simply sits there in the background.
    const popSnap = await call('find', { text: 'Open cross-site popup' });
    const popRef = /\[button:(\d+)\]/.exec(textOf(popSnap))?.[1];
    if (popRef) {
      const tabsBefore = textOf(await call('list_tabs', {}));
      const popped = await call('click', { ref: Number(popRef) });
      /Blocked by user policy/.test(textOf(popped))
        ? ok('a popup onto a blocked site is refused')
        : bad('popup onto blocked site refused', textOf(popped).slice(0, 160));

      await page.waitForTimeout(600);
      const tabsAfter = textOf(await call('list_tabs', {}));
      !/localhost:8932/.test(tabsAfter)
        ? ok('the blocked popup tab is closed, not left open')
        : bad('blocked popup tab closed', tabsAfter.slice(0, 200));
      void tabsBefore;
    } else {
      bad('found the popup button', textOf(popSnap).slice(0, 160));
    }

    await send({ type: 'set_policy', policy: { denylist: [] } });
    await page.goto(PAGE_URL);

    // An allowlist has to bound destinations the same way.
    await send({ type: 'set_policy', policy: { denylist: [], allowlist: ['127.0.0.1'] } });
    const outside = await call('new_tab', { url: `http://localhost:8932/frame` });
    /Blocked by user policy/.test(textOf(outside))
      ? ok('allowlist bounds where a new tab may open')
      : bad('allowlist bounds new_tab', textOf(outside).slice(0, 140));

    await send({ type: 'set_policy', policy: { denylist: [], allowlist: [] } });
    await send({ type: 'set_approval_mode', mode: 'strict' });

    // ── strict mode gates an ordinary write ─────────────────────────
    const strictClick = call('click', { ref: Number(btnRef) });
    await page.waitForTimeout(700);
    const strictGate = await send({ type: 'get_status' });
    strictGate?.approvalRequest?.risk === 'write'
      ? ok('strict mode gates an ordinary click')
      : bad('strict mode gates writes', JSON.stringify(strictGate?.approvalRequest));
    await send({ type: 'resolve_approval', allow: true });
    await strictClick;

    // Reads must stay ungated even in strict, or the mode is unusable.
    const strictRead = await call('get_url', {});
    !/declined|Blocked/.test(textOf(strictRead))
      ? ok('strict mode still lets reads through')
      : bad('strict mode allows reads', textOf(strictRead).slice(0, 120));

    await send({ type: 'set_approval_mode', mode: 'auto' });

    // ── the result shape of an action that moves the page ───────────
    // The defect this covers: a click that navigated tore down the content
    // script, the post-click snapshot could not be built, and the whole call
    // came back as `snapshot.tree is not iterable` — reporting a click that
    // had already happened as a failure, which invites a retry.
    await page.goto(PAGE_URL);
    await page.waitForTimeout(300);

    const linkFind = textOf(await call('find', { selector: '#samelink' }));
    const navRef = /\[link:(\d+)\]/.exec(linkFind)?.[1];
    if (!navRef) {
      bad('found the same-site link', linkFind.slice(0, 200));
    } else {
      // A ref straight out of `find`, never through a snapshot. `find` used to
      // return the content script's own frame-local refs while `snapshot`
      // returned global ones, so the two numbering schemes were mixed in one
      // namespace and a `find` ref was translated into a different element.
      const navRes = await call('click', { ref: Number(navRef) });
      const navText = textOf(navRes);
      await page.waitForTimeout(400);

      !navRes.result?.isError
        ? ok('a click that navigates is not reported as a failure')
        : bad('navigating click succeeds', navText.slice(0, 220));

      /not iterable/.test(navText)
        ? bad('no snapshot.tree crash', navText.slice(0, 220))
        : ok('no snapshot.tree crash on a navigating click');

      /navigated/i.test(navText) && navText.includes('/next')
        ? ok('a navigating click reports where the page went')
        : bad('navigating click reports the new URL', navText.slice(0, 220));

      navText.includes('You have arrived')
        ? ok('a navigating click returns a snapshot of the NEW page')
        : bad('navigating click snapshots the new page', navText.slice(0, 220));

      const landed = textOf(await call('get_url', {}));
      landed.includes('/next')
        ? ok('the click actually navigated')
        : bad('click navigated', landed.slice(0, 160));
    }

    await page.goto(PAGE_URL);
    await page.waitForTimeout(300);

    // A click that does NOT navigate must say so, and say whether anything
    // moved — "clicked into the void" is how an agent ends up confidently
    // continuing down a dead path.
    const staticFind = textOf(await call('find', { selector: '#btn' }));
    const staticRef = /\[button:(\d+)\]/.exec(staticFind)?.[1];
    if (staticRef) {
      const staticRes = await call('click', { ref: Number(staticRef) });
      const staticText = textOf(staticRes);
      !staticRes.result?.isError && !/navigated/i.test(staticText.split('\n')[0])
        ? ok('a click that stays put reports no navigation')
        : bad('non-navigating click', staticText.slice(0, 200));

      // …and it landed on the element `find` named, which is the ref-namespace
      // check: a mistranslated ref clicks something else entirely.
      const clicks = (await page.evaluate(() => window.__log)).filter((e) => e.t === 'click');
      clicks.length > 0
        ? ok('a ref from find clicks the element find named')
        : bad('find ref clicks the right element', 'no click event on #btn');
    } else {
      bad('found the plain button by selector', staticFind.slice(0, 160));
    }

    // ── extract_text with a ref ─────────────────────────────────────
    // It used to return a bare "" for a populated container, which is
    // indistinguishable from "this section is empty" and is acted on as fact.
    const resultsFind = textOf(await call('find', { selector: '#results' }));
    const resultsRef = /:(\d+)\]/.exec(resultsFind)?.[1];
    if (!resultsRef) {
      bad('results container has a ref', resultsFind.slice(0, 200));
    } else {
      const scoped = textOf(await call('extract_text', { ref: Number(resultsRef) }));
      scoped.includes('Widget A') && scoped.includes('Rs 3,100')
        ? ok('extract_text scoped to a ref returns that section')
        : bad('extract_text with a ref', scoped.slice(0, 220));

      const whole = textOf(await call('extract_text', {}));
      whole.includes('Widget A')
        ? ok('extract_text without a ref still reads the page')
        : bad('extract_text unscoped', whole.slice(0, 200));
    }

    const emptyFind = textOf(await call('find', { selector: '#emptybox' }));
    const emptyRef = /:(\d+)\]/.exec(emptyFind)?.[1];
    if (emptyRef) {
      const emptyText = textOf(await call('extract_text', { ref: Number(emptyRef) }));
      /no readable text/i.test(emptyText)
        ? ok('a genuinely empty element says so instead of returning nothing')
        : bad('empty element reported', emptyText.slice(0, 200));
    } else {
      bad('empty container has a ref', emptyFind.slice(0, 160));
    }

    const goneText = textOf(await call('extract_text', { ref: 999999 }));
    /no element with ref/i.test(goneText)
      ? ok('a ref that resolves to nothing is reported, not answered with ""')
      : bad('dead ref reported', goneText.slice(0, 200));

    // Text inside a shadow root is the walker's blind spot, and the likeliest
    // cause of a populated container reading as empty.
    const shadowText = textOf(await call('extract_text', {}));
    shadowText.includes('Shadow article body')
      ? ok('extract_text reaches text inside a shadow root')
      : bad('extract_text reads shadow DOM', shadowText.slice(0, 200));

    // ── reading link destinations instead of clicking them ──────────
    const linkResults = textOf(await call('find', { selector: 'a.result' }));
    /\/next\?id=1/.test(linkResults)
      ? ok('find reports absolute hrefs for links')
      : bad('find reports hrefs', linkResults.slice(0, 220));

    const attrs = textOf(await call('dom_query', { selector: 'a.result', action: 'attr', attr: 'href' }));
    /\/next\?id=2/.test(attrs)
      ? ok('dom_query can read an attribute across matches')
      : bad('dom_query attr', attrs.slice(0, 220));

    // A relative href handed straight to navigate goes nowhere, so it has to
    // come back resolved.
    /http:\/\/127\.0\.0\.1:8931\/next\?id=1/.test(attrs)
      ? ok('a relative href comes back absolute')
      : bad('relative href resolved', attrs.slice(0, 220));

    // And a javascript: target reports as no destination, the same answer find
    // and dom_query list give — the three must not disagree.
    !/javascript:/.test(attrs) && /\(none\)/.test(attrs)
      ? ok('a javascript: href reports as no destination')
      : bad('javascript: href suppressed', attrs.slice(0, 220));

    !/javascript:/.test(linkResults)
      ? ok('find omits javascript: targets too')
      : bad('find omits javascript: hrefs', linkResults.slice(0, 220));

    // ── navigate without paying for a snapshot ──────────────────────
    // On a real results page the snapshot is almost the entire cost of the
    // call, and there was no way to decline it.
    await call('navigate', { url: `${PAGE_URL}next` });
    const quietText = textOf(await call('navigate', { url: PAGE_URL, snapshot: false }));
    await call('navigate', { url: `${PAGE_URL}next` });
    const loudText = textOf(await call('navigate', { url: PAGE_URL }));

    quietText.includes(PAGE_URL) && !/\[button:/.test(quietText)
      ? ok('navigate with snapshot:false returns the URL and no page tree')
      : bad('navigate snapshot:false', quietText.slice(0, 220));

    /\[button:/.test(loudText) && loudText.length > quietText.length * 3
      ? ok('the snapshot is what costs, and it is now optional', `${quietText.length} vs ${loudText.length} chars`)
      : bad('navigate snapshot cost', `${quietText.length} vs ${loudText.length} chars`);

    await page.goto(PAGE_URL);
    await page.waitForTimeout(300);

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

  // ── two agents, two windows ─────────────────────────────────────────
  // The isolation claim: separate agent sessions can drive separate windows
  // without reaching into each other's. This is the scenario that motivated the
  // whole multi-session design, so it gets tested against real windows.
  let srv2;
  const home2 = mkdtempSync(join(tmpdir(), 'onbridge-browser2-'));
  if (paired) {
    // Wait for the anti-nuisance window to close before starting the second
    // agent, so this exercises the case that actually bites — an agent started
    // well after control mode was switched on — instead of depending on how long
    // the preceding tests happened to take.
    for (let i = 0; i < 90; i++) {
      const st = await send({ type: 'get_status' });
      if (st?.pairWindowOpen === false) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    srv2 = spawn('node', [join(ROOT, 'packages/mcp-server/dist/index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ONBRIDGE_HOME: home2, ONBRIDGE_AGENT_NAME: 'Second Agent' },
    });
    srv2.stderr.on('data', (d) => process.env.V && process.stderr.write(`[srv2] ${d}`));
    let buf2 = '';
    const waiters2 = new Map();
    srv2.stdout.on('data', (d) => {
      buf2 += d;
      const lines = buf2.split('\n');
      buf2 = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        try { const m = JSON.parse(l); waiters2.get(m.id)?.(m); waiters2.delete(m.id); } catch {}
      }
    });
    let id2 = 1;
    const rpc2 = (method, params = {}) => new Promise((res, rej) => {
      const i = id2++;
      waiters2.set(i, res);
      srv2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
      setTimeout(() => waiters2.delete(i) && rej(new Error(`${method} timeout`)), 30000);
    });
    const call2 = (name, args = {}) => rpc2('tools/call', { name, arguments: args });
    await rpc2('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify2', version: '1' },
    });

    // A genuinely separate browser window. ctx.newPage() would only add a tab to
    // the existing one, which would not exercise window isolation at all.
    const win1Id = await panel.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
    const win2Id = await panel.evaluate(
      (url) => chrome.windows.create({ url }).then((w) => w.id),
      PAGE_URL,
    );
    const winIds = [win1Id, win2Id];
    await new Promise((r) => setTimeout(r, 1500));

    // Pair and grant the second agent. It must appear as a distinct session.
    let sess2 = null;
    let lastSeen = [];
    let sawBlocked = false;
    // A port that failed a probe backs off for 20s before it is retried, and the
    // sweep itself runs every 10s — so a newly started agent can take about half
    // a minute to be noticed. Poll well past that rather than racing it.
    for (let i = 0; i < 120; i++) {
      const st = await send({ type: 'get_status' });
      // New agents are only accepted shortly after the user turns control mode
      // on. By now that window has long lapsed, which is exactly the situation a
      // user hits when they start a second agent mid-session: the panel must say
      // so and offer a way in, rather than leaving it silently unable to connect.
      if (st?.pairBlocked) {
        sawBlocked = true;
        await send({ type: 'arm_pairing' });
      }
      if (st?.pairRequest) await send({ type: 'resolve_pairing', allow: true });
      lastSeen = (st?.sessions ?? []).map((x) => `${x.agent?.name ?? '?'}:${x.status}@${x.port}`);
      const found = (st?.sessions ?? []).find(
        (s) => s.agent?.name === 'Second Agent' && (s.status === 'on_hold' || s.status === 'active'),
      );
      if (found) { sess2 = found; break; }
      await new Promise((r) => setTimeout(r, 500));
    }

    sawBlocked
      ? ok('a late-arriving agent is reported, not silently refused')
      : bad('late pairing surfaced', 'pairBlocked was never set — the refusal was silent');

    sess2
      ? ok('a second agent is discovered as its own session')
      : bad('second agent discovered', `sessions seen: [${lastSeen.join(', ')}]`);

    if (sess2) {
      const both = await send({ type: 'get_status' });
      const names = (both.sessions ?? []).map((s) => s.agent?.name).filter(Boolean);
      names.includes('Verify Bot') && names.includes('Second Agent')
        ? ok('both agents are listed with distinct identities')
        : bad('two distinct agents listed', names.join(', '));

      // The first agent already holds 'all'. A second browser-wide grant must be
      // refused rather than silently letting two agents fight over one browser.
      const clash = await send({ type: 'activate_session', id: sess2.id, scope: 'all' });
      !clash?.ok && /already controls/i.test(clash?.reason ?? '')
        ? ok('an overlapping grant is refused with a reason')
        : bad('overlapping grant refused', JSON.stringify(clash));

      // Narrow the first agent to one window so the second can hold the other.
      await send({ type: 'hold_session', id: sessionId });
      const w1 = await send({ type: 'activate_session', id: sessionId, windowId: winIds[0], scope: 'window' });
      const w2 = await send({ type: 'activate_session', id: sess2.id, windowId: winIds[1], scope: 'window' });
      w1?.ok && w2?.ok
        ? ok('two agents can hold two different windows at once')
        : bad('two agents hold two windows', JSON.stringify({ w1, w2 }));

      if (w1?.ok && w2?.ok) {
        // The isolation boundary itself: agent 1 naming a tab in agent 2's
        // window must be refused, not silently served.
        const tabsIn2 = await panel.evaluate(
          (wid) => chrome.tabs.query({ windowId: wid }).then((t) => t.map((x) => x.id)),
          winIds[1],
        );
        // `switch_tab` takes a tab id straight from the agent, so it is the
        // actual escape route — unlike `get_url`, which takes no target and
        // would silently answer about the agent's own window either way.
        const cross = await call('switch_tab', { tabId: tabsIn2[0] });
        /Access denied/i.test(textOf(cross))
          ? ok('an agent cannot reach into the other agent window')
          : bad('cross-window access denied', textOf(cross).slice(0, 160));

        // And the same call inside its own window must still work, so the check
        // above is proving isolation rather than a broken switch_tab.
        const tabsIn1 = await panel.evaluate(
          (wid) => chrome.tabs.query({ windowId: wid }).then((t) => t.map((x) => x.id)),
          winIds[0],
        );
        const sameWindow = await call('switch_tab', { tabId: tabsIn1[0] });
        !/Access denied/i.test(textOf(sameWindow))
          ? ok('switch_tab still works within the granted window')
          : bad('switch_tab works in own window', textOf(sameWindow).slice(0, 160));

        // And each agent still works inside its own window.
        const own = await call2('get_url', {});
        !/Access denied|not been given/i.test(textOf(own))
          ? ok('each agent still works inside its own window')
          : bad('agent works in its own window', textOf(own).slice(0, 160));

        // A panel opened in window 2 must report window 2's agent, not window 1's.
        const panel2 = await ctx.newPage();
        await panel2.goto(`chrome-extension://${extId}/sidepanel.html`);
        const st2 = await panel2.evaluate(
          (wid) => new Promise((r) => chrome.runtime.sendMessage({ type: 'get_status', windowId: wid }, r)),
          winIds[1],
        );
        st2?.sessions?.find((s) => s.ownsThisWindow)?.agent?.name === 'Second Agent'
          ? ok('the panel reports the agent controlling its own window')
          : bad(
              'panel is window-aware',
              st2?.sessions?.find((s) => s.ownsThisWindow)?.agent?.name ?? 'none',
            );
      }
    }
  }

  await ctx.close();
  srv.kill();
  srv2?.kill();
  rmSync(home2, { recursive: true, force: true });
  http.close();
  xhttp.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });

  console.log('\n' + results.join('\n'));
  const failed = results.filter((r) => r.includes('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
