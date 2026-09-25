/**
 * Under protocol revision 2026-07-28 there is no `initialize`: the client names itself in every request's `_meta` envelope. Claude Code speaks that revision, and over stdio the SDK never copies the envelope into `getClientVersion()`, so every Claude Code session was shown to the user as a guess.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { startServer, openSession, waitForListening, type Harness, type Session } from './session-helper.js';

let h: Harness;
let session: Session | undefined;
afterAll(async () => {
  await session?.close();
  h?.stop();
});

const textOf = (res: any): string => (res.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
const envelope = (version: string) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version },
  'io.modelcontextprotocol/clientCapabilities': {},
});

describe('who the agent is', () => {
  it('comes from the request envelope, not a guess, and carries a connection code the agent sees too', async () => {
    h = startServer();
    const heard: any[] = [];
    // The first request opens the connection in the modern era; the browser connects while it waits.
    const first = h.rpc('tools/call', { name: 'bridge_status', arguments: {}, _meta: envelope('1.0.0') });
    await waitForListening();
    session = await openSession({ onServerMessage: (m) => heard.push(m) });
    const firstText = textOf(await first);
    const code = /Connection code: ([A-Z0-9]{4})/.exec(firstText)?.[1];
    expect(code, firstText).toBeTruthy();

    // A client that updates mid-session is picked up and pushed to the panel.
    await h.rpc('tools/call', { name: 'bridge_status', arguments: {}, _meta: envelope('1.0.1') });
    await new Promise((r) => setTimeout(r, 200));
    const identity = heard.filter((m) => m.type === 'agent_identity').at(-1)?.agent;
    expect(identity).toMatchObject({ name: 'Claude Code', version: '1.0.1', source: 'mcp', code });
  });
});
