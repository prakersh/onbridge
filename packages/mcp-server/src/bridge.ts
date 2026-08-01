import { WebSocketServer, WebSocket } from 'ws';
import { WS_PORT, HEARTBEAT_INTERVAL_MS, COMMAND_TIMEOUT_MS } from '@onbridge/shared';
import type { ServerMessage, ExtensionMessage, CommandAction } from '@onbridge/shared';

type PendingCommand = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class Bridge {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingCommand>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cmdCounter = 0;

  constructor() {
    this.wss = new WebSocketServer({ port: WS_PORT });
    this.log(`WebSocket server listening on port ${WS_PORT}`);

    this.wss.on('connection', (ws) => {
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        ws.close(4000, 'Another client is already connected');
        return;
      }

      this.client = ws;
      this.log('Extension connected');
      this.startHeartbeat();

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as ExtensionMessage;
          this.handleMessage(msg);
        } catch {
          this.log('Failed to parse message from extension');
        }
      });

      ws.on('close', () => {
        this.log('Extension disconnected');
        this.client = null;
        this.stopHeartbeat();
        for (const [id, cmd] of this.pending) {
          cmd.reject(new Error('Extension disconnected'));
          clearTimeout(cmd.timer);
          this.pending.delete(id);
        }
      });

      ws.on('error', (err) => {
        this.log(`WebSocket error: ${err.message}`);
      });
    });
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  async sendCommand(action: CommandAction, params: Record<string, unknown> = {}, tabId?: number): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error('Extension not connected. Enable control mode in the onbridge extension and ensure the extension is installed.');
    }

    const id = `cmd_${++this.cmdCounter}`;
    const msg: ServerMessage = { type: 'command', id, action, params };
    if (tabId != null) msg.tabId = tabId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.client!.send(JSON.stringify(msg));
    });
  }

  private handleMessage(msg: ExtensionMessage): void {
    switch (msg.type) {
      case 'ready':
        this.log(`Extension ready: v${msg.version}, control mode: ${msg.controlMode}`);
        break;

      case 'result': {
        const cmd = this.pending.get(msg.id);
        if (cmd) {
          clearTimeout(cmd.timer);
          this.pending.delete(msg.id);
          if (msg.success) {
            cmd.resolve(msg.data);
          } else {
            cmd.reject(new Error(msg.error ?? 'Command failed'));
          }
        }
        break;
      }

      case 'event':
        this.log(`Event: ${msg.event} — ${JSON.stringify(msg.data)}`);
        break;

      case 'pong':
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected()) {
        const msg: ServerMessage = { type: 'ping' };
        this.client!.send(JSON.stringify(msg));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private log(msg: string): void {
    process.stderr.write(`[onbridge] ${msg}\n`);
  }

  close(): void {
    this.stopHeartbeat();
    this.client?.close();
    this.wss.close();
  }
}
