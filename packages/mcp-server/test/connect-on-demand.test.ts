/**
 * By default a server does not listen until its agent first calls a tool. Every editor session starts one, including sessions that never touch the browser, and listening at startup made each of them show up in the side panel, ask to pair and hold one of the ten ports.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { startServer, openSession, waitForListening, getPort, type Harness, type Session } from './session-helper.js';

let h: Harness | undefined;
let session: Session | undefined;

afterAll(async () => {
  await session?.close();
  h?.stop();
});

const textOf = (res: any): string => (res.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('connecting on first use', () => {
  it('stays invisible to the browser until the agent calls a tool, then connects within that call', async () => {
    h = startServer({ ONBRIDGE_CONNECT: undefined });
    await h.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } });

    await sleep(1000);
    expect(() => getPort(), 'listened before any tool was called').toThrow();

    // The agent's first tool call is the request to connect. The browser picks the agent up while the call waits.
    const call = h.rpc('tools/call', { name: 'bridge_status', arguments: {} });
    await waitForListening();
    session = await openSession();

    expect(textOf(await call)).toMatch(/Extension: CONNECTED/);
  });
});
