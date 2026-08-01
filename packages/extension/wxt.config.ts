import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'onbridge',
    description: 'Browser control for AI agents via MCP',
    permissions: ['activeTab', 'tabs', 'storage', 'scripting', 'downloads', 'debugger', 'cookies'],
    host_permissions: ['<all_urls>'],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
