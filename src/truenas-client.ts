import WebSocket from 'ws';
import { Agent } from 'https';
import { randomUUID } from 'crypto';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class TrueNASClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingCall>();
  private connected = false;
  private reconnectDelay = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    private readonly host: string,
    private readonly apiKey: string,
    private readonly insecure: boolean = false,
  ) {}

  connect(): Promise<void> {
    return this._connect();
  }

  private _connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://${this.host}/api/current`;
      const wsOptions: WebSocket.ClientOptions = {};
      if (this.insecure) {
        wsOptions.agent = new Agent({ rejectUnauthorized: false });
      }

      const ws = new WebSocket(url, wsOptions);
      this.ws = ws;

      ws.once('error', reject);

      ws.once('open', () => {
        ws.off('error', reject);
        this.connected = true;
        this.reconnectDelay = 1000;

        ws.on('message', (data) => this.onMessage(data.toString()));
        ws.on('close', () => this.onClose());
        ws.on('error', (err) => {
          process.stderr.write(`[truenas-mcp] WebSocket error: ${err.message}\n`);
        });

        this.authenticate().then(resolve).catch(reject);
      });
    });
  }

  private async authenticate(): Promise<void> {
    const ok = await this.rawCall('auth.login_with_api_key', [this.apiKey]);
    if (ok !== true) {
      throw new Error('TrueNAS authentication failed — check your API key');
    }
  }

  private onMessage(raw: string): void {
    let msg: { id?: string; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg.id) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(`TrueNAS error [${msg.error.code}]: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private onClose(): void {
    this.connected = false;

    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('WebSocket connection closed'));
      this.pending.delete(id);
    }

    if (!this.shuttingDown) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    process.stderr.write(`[truenas-mcp] Reconnecting in ${delay}ms…\n`);
    this.reconnectTimer = setTimeout(() => {
      this._connect()
        .then(() => {
          process.stderr.write('[truenas-mcp] Reconnected.\n');
        })
        .catch(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
          this.scheduleReconnect();
        });
    }, delay);
  }

  private rawCall(method: string, params: unknown[]): Promise<unknown> {
    if (!this.ws || !this.connected) {
      return Promise.reject(new Error('Not connected to TrueNAS'));
    }
    const id = randomUUID();
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response to: ${method}`));
      }, 30_000);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(payload);
    });
  }

  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.rawCall(method, params) as Promise<T>;
  }

  disconnect(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}
