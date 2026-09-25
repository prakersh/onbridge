import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The handshake suite spawns a real server and drives a real socket.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One bridge binds one port, so suites must not race each other for it.
    fileParallelism: false,
    // Test servers bind 19876-19885, a range the extension never scans, so a contributor's own browser cannot find them and their own agents cannot starve the suites of ports. See serverPortRange().
    // The suites pair fixture extension ids and exercise trust-on-first-use, so they run in the development mode that accepts any extension.
    // And they pair before calling any tool, so their servers listen at startup rather than on first use; connect-on-demand.test.ts covers the default.
    env: { ONBRIDGE_PORT_BASE: '19876', ONBRIDGE_ALLOW_ANY_EXTENSION: '1', ONBRIDGE_CONNECT: 'startup' },
  },
});
