/**
 * Renders the extension icons from packages/extension/design/icon/*.svg into packages/extension/public/.
 *
 *   node scripts/render-icons.mjs
 *
 * Two drawings, two states. The detailed drawing (padding, drop shadow, glow) is used at 48 and 128px; the small one is full-bleed with heavier strokes, because detail turns to noise at 16px. `icon/` is the green set: Chrome uses it on the Web Store and chrome://extensions, and the toolbar shows it while Control Mode is on. `icon-idle/` is the grey toolbar set.
 *
 * Rasterised by the Chromium that the browser suite already uses, so there is no image dependency to install.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'packages/extension/design/icon');
const OUT = join(ROOT, 'packages/extension/public');

const OUTPUTS = [
  { dir: 'icon', size: 16, svg: 'icon-small.svg' },
  { dir: 'icon', size: 32, svg: 'icon-small.svg' },
  { dir: 'icon', size: 48, svg: 'icon.svg' },
  { dir: 'icon', size: 128, svg: 'icon.svg' },
  { dir: 'icon-idle', size: 16, svg: 'icon-small-idle.svg' },
  { dir: 'icon-idle', size: 32, svg: 'icon-small-idle.svg' },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { dir, size, svg } of OUTPUTS) {
    const data = readFileSync(join(SRC, svg)).toString('base64');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}img{display:block}</style><img src="data:image/svg+xml;base64,${data}" width="${size}" height="${size}">`,
    );
    await page.waitForFunction(() => document.querySelector('img').complete);
    mkdirSync(join(OUT, dir), { recursive: true });
    const file = join(OUT, dir, `${size}.png`);
    await page.screenshot({ path: file, omitBackground: true });
    console.log(`${svg} -> public/${dir}/${size}.png`);
  }
} finally {
  await browser.close();
}
