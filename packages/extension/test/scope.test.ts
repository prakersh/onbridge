/**
 * Isolation between concurrent agents.
 *
 * The whole multi-session promise rests on these: an agent granted one window
 * must not be able to touch another, and two agents must never be handed
 * overlapping territory. A bug here is not a glitch — it is one project's agent
 * typing into another project's tabs.
 */

import { describe, it, expect } from 'vitest';
import {
  overlaps,
  scopeAllows,
  describeScope,
  decideRestore,
  type AgentSession,
  type SessionScope,
} from '../src/core/connection-manager.js';

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

describe('restoring territory across a reconnect', () => {
  const session = (over: Partial<AgentSession>): AgentSession =>
    ({
      id: 'port:9877',
      port: 9877,
      status: 'active',
      detail: '',
      scope: null,
      connectedAt: 0,
      commandCount: 0,
      lastAction: '',
      activityLog: [],
      attempts: 1,
      ...over,
    }) as AgentSession;

  it('gives a restarted server its window back', () => {
    // `npx` respawns servers constantly; re-granting every time is intolerable.
    expect(decideRestore(win(1), 'srv-a', 'srv-a', []).restore).toBe(true);
  });

  it('refuses to hand a recycled port to a different agent', () => {
    // A port is reused the moment its owner exits. Matching on port alone gave
    // the newcomer the previous agent's window for free.
    const v = decideRestore(win(1), 'srv-a', 'srv-b', []);
    expect(v.restore).toBe(false);
    expect(v.reason).toMatch(/different agent/i);
  });

  it('refuses when someone else was granted that scope meanwhile', () => {
    // A failed session keeps its scope and activate() only compares against
    // active ones, so the window could be given away and then silently reclaimed
    // here — two agents driving one window.
    const other = session({ id: 'port:9878', scope: win(1), identity: { name: 'Other' } as never });
    const v = decideRestore(win(1), 'srv-a', 'srv-a', [other]);
    expect(v.restore).toBe(false);
    expect(v.reason).toMatch(/Other now controls/);
  });

  it('ignores a clash with a session that is not active', () => {
    const idle = session({ id: 'port:9878', scope: win(1), status: 'on_hold' });
    expect(decideRestore(win(1), 'srv-a', 'srv-a', [idle]).restore).toBe(true);
  });

  it('restores nothing when there was no grant to begin with', () => {
    expect(decideRestore(null, 'srv-a', 'srv-a', []).restore).toBe(false);
  });

  it('refuses when the server did not identify itself', () => {
    expect(decideRestore(win(1), 'srv-a', '', []).restore).toBe(false);
  });
});
