export type CommandAction =
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'snapshot'
  | 'find'
  | 'screenshot'
  | 'get_text'
  | 'get_url'
  | 'click'
  | 'click_by_text'
  | 'type'
  | 'fill_form'
  | 'select'
  | 'hover'
  | 'scroll'
  | 'press_key'
  | 'drag'
  | 'upload'
  | 'dismiss_modal'
  | 'dom_query'
  | 'list_tabs'
  | 'switch_tab'
  | 'new_tab'
  | 'close_tab'
  | 'evaluate'
  | 'wait'
  | 'get_cookies'
  | 'set_cookie'
  | 'console_logs'
  | 'download_file'
  | 'list_downloads'
  | 'activity_log';

// MCP Server → Extension
export type ServerMessage =
  | { type: 'command'; id: string; action: CommandAction; params: Record<string, unknown>; tabId?: number }
  | { type: 'ping' };

// Extension → MCP Server
export type ExtensionMessage =
  | { type: 'ready'; version: string; controlMode: boolean }
  | { type: 'result'; id: string; success: boolean; data: unknown; error?: string; timing: number }
  | {
      type: 'event';
      event: 'navigation' | 'tab_changed' | 'dialog' | 'control_mode_changed';
      data: unknown;
    }
  | { type: 'pong' };

export const WS_PORT = 9876;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const COMMAND_TIMEOUT_MS = 30_000;
