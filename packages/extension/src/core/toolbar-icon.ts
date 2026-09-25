/**
 * The toolbar icon mirrors Control Mode: grey while it is off, emerald while it is on, so whether an agent *can* act is visible without opening the panel.
 *
 * `icon/` doubles as the manifest icon set (Web Store, chrome://extensions), which is why the "on" state lives there rather than in a folder of its own. Both sets are rendered from `design/icon/` by `scripts/render-icons.mjs`.
 */
export const TOOLBAR_ICON = {
  idle: { 16: 'icon-idle/16.png', 32: 'icon-idle/32.png' },
  on: { 16: 'icon/16.png', 32: 'icon/32.png' },
} as const;

export function toolbarIconFor(controlMode: boolean) {
  return controlMode ? TOOLBAR_ICON.on : TOOLBAR_ICON.idle;
}
