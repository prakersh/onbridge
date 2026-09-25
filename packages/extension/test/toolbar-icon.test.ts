import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLBAR_ICON, toolbarIconFor } from '../src/core/toolbar-icon.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const buf = readFileSync(join(PUBLIC, path));
  expect(buf.subarray(1, 4).toString('latin1'), `${path} is not a PNG`).toBe('PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('toolbar icon', () => {
  it('is grey while Control Mode is off and emerald while it is on', () => {
    expect(toolbarIconFor(false)).toBe(TOOLBAR_ICON.idle);
    expect(toolbarIconFor(true)).toBe(TOOLBAR_ICON.on);
  });

  it('points only at files that ship, at the size each slot declares', () => {
    for (const set of [TOOLBAR_ICON.idle, TOOLBAR_ICON.on]) {
      for (const [size, path] of Object.entries(set)) {
        expect(pngSize(path)).toEqual([Number(size), Number(size)]);
      }
    }
  });

  // WXT builds the manifest's `icons` from public/icon/<size>.png. These are what the Web Store and chrome://extensions show.
  it('ships the full manifest icon set', () => {
    for (const size of [16, 32, 48, 128]) {
      expect(pngSize(`icon/${size}.png`)).toEqual([size, size]);
    }
  });

  it('really has two different states', () => {
    for (const size of [16, 32] as const) {
      const idle = readFileSync(join(PUBLIC, TOOLBAR_ICON.idle[size]));
      const on = readFileSync(join(PUBLIC, TOOLBAR_ICON.on[size]));
      expect(idle.equals(on)).toBe(false);
    }
  });
});
