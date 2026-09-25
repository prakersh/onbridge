#!/usr/bin/env node
/**
 * Chrome Web Store upload, publish and status, from this machine.
 *
 * Credentials come from a file outside the repository, written once by
 * chrome-web-store.auth.mjs:
 *
 *   ~/.config/onbridge/chrome-web-store.env      (override: ONBRIDGE_CWS_ENV)
 *
 * Usage:
 *   node scripts/release/chrome-web-store.publish.mjs status
 *   node scripts/release/chrome-web-store.publish.mjs upload  [--zip <path>]
 *   node scripts/release/chrome-web-store.publish.mjs publish [--percent <1-100>]
 *   node scripts/release/chrome-web-store.publish.mjs release [--zip <path>] [--percent <1-100>]
 *
 * `release` is upload followed by publish. The zip defaults to
 * artifacts/onbridge-extension-v<VERSION>.zip. Publishing submits the version
 * for review; the store still reviews it before users see it.
 *
 * API reference: https://developer.chrome.com/docs/webstore/api
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_PATH =
  process.env.ONBRIDGE_CWS_ENV ?? join(homedir(), '.config', 'onbridge', 'chrome-web-store.env');
const API = 'https://chromewebstore.googleapis.com';

const [, , command = 'status', ...rest] = process.argv;
const opts = new Map();
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts.set(rest[i].slice(2), rest[i + 1] ?? '');
}

function fail(msg) {
  console.error(`[cws] error: ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[cws] ${msg}`);
}

function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    fail(`no credentials at ${ENV_PATH}. Run: node scripts/release/chrome-web-store.auth.mjs`);
  }
  const mode = statSync(ENV_PATH).mode & 0o777;
  if (mode & 0o077) {
    fail(`${ENV_PATH} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 "${ENV_PATH}"`);
  }
  const env = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const k of ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID']) {
    if (!env[k]) fail(`${k} missing from ${ENV_PATH}`);
  }
  if (!env.CWS_EXTENSION_ID) {
    fail(
      'CWS_EXTENSION_ID is not set. The first upload of a new item is done in the developer ' +
        'dashboard; afterwards run: node scripts/release/chrome-web-store.auth.mjs --extension-id <id>',
    );
  }
  return env;
}

async function accessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.CWS_CLIENT_ID,
      client_secret: env.CWS_CLIENT_SECRET,
      refresh_token: env.CWS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    fail(`could not get an access token: ${data.error_description ?? data.error ?? JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function api(token, method, path, body, contentType = 'application/json') {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': contentType } : {}),
    },
    body: body ?? undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    fail(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(data).slice(0, 800)}`);
  }
  return data;
}

const itemName = (env) => `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;

async function fetchStatus(token, env) {
  return api(token, 'GET', `/v2/${itemName(env)}:fetchStatus`);
}

function printStatus(s) {
  const pub = s.publishedItemRevisionStatus ?? {};
  const sub = s.submittedItemRevisionStatus ?? {};
  const chan = (r) => (r.distributionChannels ?? []).map((c) => `${c.crxVersion ?? '?'} @ ${c.deployPercentage ?? 100}%`).join(', ');
  log(`item        ${s.itemId ?? '?'}`);
  log(`published   ${pub.state ?? 'none'} ${chan(pub)}`);
  log(`submitted   ${sub.state ?? 'none'} ${chan(sub)}`);
  log(`last upload ${s.lastAsyncUploadState ?? 'n/a'}`);
  if (s.takenDown) log('TAKEN DOWN by policy');
  if (s.warned) log('policy warning on this item');
  if (s.publicKey) log(`public key  ${s.publicKey.slice(0, 24)}… (for manifest.key, see docs/CHROME_WEB_STORE.md)`);
}

async function upload(token, env) {
  const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
  const zip = resolve(opts.get('zip') ?? join(ROOT, 'artifacts', `onbridge-extension-v${version}.zip`));
  if (!existsSync(zip)) fail(`zip not found: ${zip} (run ./app.sh --package)`);
  log(`uploading ${zip} (${(statSync(zip).size / 1024).toFixed(0)} KB)`);

  const res = await api(token, 'POST', `/upload/v2/${itemName(env)}:upload`, readFileSync(zip), 'application/zip');
  log(`upload accepted: state=${res.uploadState ?? '?'} version=${res.crxVersion ?? 'pending'}`);

  // Large packages are processed asynchronously; wait until the store has
  // finished validating before publishing, or publish will reject it.
  for (let i = 0; i < 60; i++) {
    const s = await fetchStatus(token, env);
    const state = s.lastAsyncUploadState ?? 'UNKNOWN';
    if (state !== 'UPLOAD_IN_PROGRESS' && state !== 'UPLOAD_STATE_UNSPECIFIED') {
      if (/FAIL|ERROR/i.test(state)) fail(`upload ended in state ${state}`);
      log(`upload complete: ${state}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  fail('upload still in progress after five minutes; check the dashboard');
}

async function publish(token, env) {
  const body = { publishType: 'DEFAULT_PUBLISH' };
  if (opts.has('percent')) {
    const pct = Number(opts.get('percent'));
    if (!(pct >= 1 && pct <= 100)) fail('--percent must be between 1 and 100');
    body.deployInfos = [{ deployPercentage: pct }];
  }
  const res = await api(token, 'POST', `/v2/${itemName(env)}:publish`, JSON.stringify(body));
  log(`publish submitted: state=${res.state ?? '?'}`);
  for (const w of res.warningInfo?.warnings ?? []) log(`warning: ${w.reason}: ${w.description}`);
}

async function main() {
  const env = loadEnv();
  const token = await accessToken(env);
  switch (command) {
    case 'status':
      printStatus(await fetchStatus(token, env));
      break;
    case 'upload':
      await upload(token, env);
      break;
    case 'publish':
      await publish(token, env);
      printStatus(await fetchStatus(token, env));
      break;
    case 'release':
      await upload(token, env);
      await publish(token, env);
      printStatus(await fetchStatus(token, env));
      break;
    default:
      fail(`unknown command "${command}" (status | upload | publish | release)`);
  }
}

main().catch((err) => fail(err.message));
