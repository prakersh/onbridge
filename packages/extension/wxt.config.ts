import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'onbridge',
    description: 'Browser control for AI agents via MCP',
    // Public key of the Chrome Web Store item minhhfibhfnjdcgiipmcbfgclmeineca.
    // With it, an unpacked build gets the same extension id as the published
    // one, so the MCP server's origin allowlist matches both. The store rejects
    // packages that carry this field, so ./app.sh --package strips it from the
    // zipped manifest.
    key:
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs6wCZvYV2hWRtEIXbYkUeqmDLF/tTt5YcI6l016etS1bppV7ne7fMkoOfAdDaDGA8ryy09D06vFHeRr3ekOWJ+rairMdt8jIokRqVJnWRM1ODbTM+u0Kbt1notmn4uAFAQBf5H2LvHu/l1gBNHH90wNBo/oqQkW0lG4Fbmpz5/GEN2aSAx6gdT7KMTSFWZ6FIdwP5+JhWfzzOZCc9fyZzM+ft6+sWqgJ1MFn9CT0NH9w2ZgXNBRT296Izn7vKzKq1M4ZD2ifdxMU/kURSZ2Lly6+XtOpLSqMixN5cShcs54KeL2p8VH4VC5UJscLBuP8QWuTqKE8vk5xR5WxafXgrQIDAQAB',
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
