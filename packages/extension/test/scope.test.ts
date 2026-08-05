/**
 * Isolation between concurrent agents.
 *
 * The whole multi-session promise rests on these: an agent granted one window
 * must not be able to touch another, and two agents must never be handed
 * overlapping territory. A bug here is not a glitch — it is one project's agent
 * typing into another project's tabs.
 */

import { describe, it, expect } from 'vitest';
import { overlaps, scopeAllows, describeScope, type SessionScope } from '../src/core/connection-manager.js';

const tab = (tabId: number, windowId: number): SessionScope => ({ kind: 'tab', tabId, windowId });
const win = (windowId: number): SessionScope => ({ kind: 'window', windowId });
const all = (): SessionScope => ({ kind: 'all' });

describe('scope overlap', () => {
  it('treats two different windows as disjoint', () => {
    expect(overlaps(win(1), win(2))).toBe(false);
  });

  it('treats the same window as overlapping', () => {
    expect(overlaps(win(1), win(1))).toBe(true);
  });

  it('treats browser-wide as overlapping everything', () => {
    expect(overlaps(all(), win(9))).toBe(true);
    expect(overlaps(win(9), all())).toBe(true);
    expect(overlaps(all(), tab(3, 9))).toBe(true);
  });

  it('detects a tab sitting inside another agent window', () => {
    // The subtle case: a window grant and a single-tab grant look unrelated
    // until you notice the tab lives in that window.
    expect(overlaps(win(1), tab(50, 1))).toBe(true);
    expect(overlaps(tab(50, 1), win(1))).toBe(true);
  });

  it('lets a tab in a different window coexist with a window grant', () => {
    expect(overlaps(win(1), tab(50, 2))).toBe(false);
  });

  it('treats two distinct tabs as disjoint', () => {
    expect(overlaps(tab(1, 1), tab(2, 1))).toBe(false);
  });
});

describe('scope enforcement', () => {
  it('confines a window grant to its own window', () => {
    expect(scopeAllows(win(7), 100, 7)).toBe(true);
    expect(scopeAllows(win(7), 100, 8)).toBe(false);
  });

  it('confines a tab grant to exactly one tab', () => {
    expect(scopeAllows(tab(100, 7), 100, 7)).toBe(true);
    expect(scopeAllows(tab(100, 7), 101, 7)).toBe(false);
  });

  it('lets a browser-wide grant reach anything', () => {
    expect(scopeAllows(all(), 999, 999)).toBe(true);
  });
});

describe('scope description', () => {
  it('reads as plain English in error messages and the panel', () => {
    expect(describeScope(all())).toBe('the whole browser');
    expect(describeScope(win(1))).toBe('this window');
    expect(describeScope(tab(1, 1))).toBe('a single tab');
  });
});
