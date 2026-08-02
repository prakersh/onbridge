import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The handshake suite spawns a real server and drives a real socket.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One bridge binds one port, so suites must not race each other for it.
    fileParallelism: false,
  },
});
