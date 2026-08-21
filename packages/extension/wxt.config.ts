import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'onbridge',
    description: 'Browser control for AI agents via MCP',
    permissions: [
      'activeTab',
      'tabs',
      'storage',
      'scripting',
      'downloads',
      'debugger',
      'cookies',
      'sidePanel',
      'notifications',
      // Enumerating frames is how a snapshot reaches inside iframes.
      'webNavigation',
      // Timers do not survive MV3 worker suspension; alarms do. Idle-revoke and
      // agent discovery both depend on still running on a quiet browser.
      'alarms',
    ],
    host_permissions: ['<all_urls>'],
    side_panel: { default_path: 'sidepanel.html' },
    // Declared with no default_popup on purpose: the toolbar icon must open the
    // side panel in one click. The key itself is still required — without it
    // there is no toolbar button and chrome.action.setBadgeText does nothing.
    action: {},
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
