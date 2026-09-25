#!/usr/bin/env node
/**
 * One-time Chrome Web Store credential setup. Run it once per machine.
 *
 * Walks the OAuth consent flow for the Chrome Web Store API and stores the
 * resulting refresh token, together with the client id, client secret,
 * publisher id and extension id, in a file OUTSIDE the repository:
 *
 *   ~/.config/onbridge/chrome-web-store.env   (directory 0700, file 0600)
 *
 * Nothing here is ever written inside the repo, and the publish script reads
 * only that file. Override the location with ONBRIDGE_CWS_ENV.
 *
 * Prerequisites (about ten minutes, once):
 *   1. https://console.cloud.google.com : create or pick a project, enable the
 *      "Chrome Web Store API".
 *   2. APIs & Services > OAuth consent screen: External, add yourself as a test
 *      user (the app can stay in Testing).
 *   3. APIs & Services > Credentials > Create credentials > OAuth client ID,
 *      application type "Desktop app". Note the client id and client secret.
 *   4. https://chrome.google.com/webstore/devconsole : the publisher id is
 *      shown under Account, and the extension id under the item once it exists.
 *
 * Usage:
 *   node scripts/release/chrome-web-store.auth.mjs
 *   node scripts/release/chrome-web-store.auth.mjs --extension-id <id>   # update one field
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const ENV_PATH =
  process.env.ONBRIDGE_CWS_ENV ?? join(homedir(), '.config', 'onbridge', 'chrome-web-store.env');

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function writeEnvFile(path, values) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const body =
    [
      '# Chrome Web Store credentials for onbridge releases. Never commit this file.',
      `# Written by scripts/release/chrome-web-store.auth.mjs on ${new Date().toISOString()}`,
      ...Object.entries(values)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`),
    ].join('\n') + '\n';
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function ask(rl, label, current) {
  const suffix = current ? ` [${current.slice(0, 6)}…]` : '';
  const v = (await rl.question(`${label}${suffix}: `)).trim();
  return v || current || '';
}

function openBrowser(url) {
  // ONBRIDGE_AUTH_BROWSER names a macOS application to open the consent page in,
  // for when the default browser is not the one signed in to the right account.
  const app = process.env.ONBRIDGE_AUTH_BROWSER;
  if (process.platform === 'darwin' && app) {
    spawn('open', ['-a', app, url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

/** Runs the loopback consent flow and returns a refresh token. */
async function obtainRefreshToken(clientId, clientSecret) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/`;
  const state = Math.random().toString(36).slice(2);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

  console.log('\nOpening the Google consent page in your browser. If it does not open, visit:\n');
  console.log(`  ${authUrl}\n`);
  openBrowser(authUrl.toString());

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the consent redirect')), 5 * 60_000);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get('error');
      const got = u.searchParams.get('code');
      if (u.searchParams.get('state') !== state || err || !got) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`Authorisation failed: ${err ?? 'bad state'}`);
        clearTimeout(timer);
        reject(new Error(err ?? 'state mismatch'));
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<p style="font-family:system-ui">onbridge is authorised. You can close this tab.</p>');
      clearTimeout(timer);
      resolve(got);
    });
  }).finally(() => server.close());

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!data.refresh_token) {
    throw new Error(`token exchange returned no refresh_token: ${JSON.stringify(data)}`);
  }
  return data.refresh_token;
}

async function main() {
  const existing = readEnvFile(ENV_PATH);
  const values = { ...existing };

  // Field-only update, no consent flow.
  const fieldFlags = {
    'publisher-id': 'CWS_PUBLISHER_ID',
    'extension-id': 'CWS_EXTENSION_ID',
    'client-id': 'CWS_CLIENT_ID',
    'client-secret': 'CWS_CLIENT_SECRET',
  };
  let fieldsOnly = false;
  for (const [flag, key] of Object.entries(fieldFlags)) {
    if (args.has(flag)) {
      values[key] = args.get(flag);
      fieldsOnly = true;
    }
  }
  if (fieldsOnly && !args.has('reauth')) {
    writeEnvFile(ENV_PATH, values);
    console.log(`Updated ${ENV_PATH}`);
    return;
  }

  // Non-interactive: every required value supplied by flag or already stored.
  const complete = values.CWS_CLIENT_ID && values.CWS_CLIENT_SECRET && values.CWS_PUBLISHER_ID;
  const rl = complete && args.has('reauth') ? null : createInterface({ input: stdin, output: stdout });
  try {
    if (!rl) {
      console.log(`Using stored values; credentials will be stored in ${ENV_PATH} (mode 0600).`);
    } else {
    console.log(`Credentials will be stored in ${ENV_PATH} (mode 0600).\n`);
    values.CWS_CLIENT_ID = await ask(rl, 'OAuth client id', values.CWS_CLIENT_ID);
    values.CWS_CLIENT_SECRET = await ask(rl, 'OAuth client secret', values.CWS_CLIENT_SECRET);
    values.CWS_PUBLISHER_ID = await ask(rl, 'Publisher id (developer dashboard > Account)', values.CWS_PUBLISHER_ID);
    values.CWS_EXTENSION_ID = await ask(
      rl,
      'Extension id (leave blank until the first dashboard upload)',
      values.CWS_EXTENSION_ID,
    );
    }
  } finally {
    rl?.close();
  }
  if (!values.CWS_CLIENT_ID || !values.CWS_CLIENT_SECRET || !values.CWS_PUBLISHER_ID) {
    throw new Error('client id, client secret and publisher id are all required');
  }

  values.CWS_REFRESH_TOKEN = await obtainRefreshToken(values.CWS_CLIENT_ID, values.CWS_CLIENT_SECRET);
  writeEnvFile(ENV_PATH, values);
  console.log(`\nSaved ${ENV_PATH}`);

  if (values.CWS_EXTENSION_ID) {
    console.log('Verifying with fetchStatus...');
    const publishScript = join(dirname(new URL(import.meta.url).pathname), 'chrome-web-store.publish.mjs');
    const child = spawn(process.execPath, [publishScript, 'status'], {
      stdio: 'inherit',
      env: { ...process.env, ONBRIDGE_CWS_ENV: ENV_PATH },
    });
    await new Promise((r) => child.on('exit', r));
  } else {
    console.log('No extension id yet. After the first dashboard upload, run:');
    console.log('  node scripts/release/chrome-web-store.auth.mjs --extension-id <id>');
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
