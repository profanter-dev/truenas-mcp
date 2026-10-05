// Docker Engine client over the local unix socket.
//
// Mounting docker.sock is root-equivalent on the host (even with :ro), so this
// client is the security boundary: every request is checked against a fixed
// allowlist of method + path, query strings are built internally only, and
// there is deliberately no generic passthrough. Add an entry here only together
// with the tool that needs it.

import http from 'node:http';
import { existsSync } from 'node:fs';

const ID = '[a-zA-Z0-9][a-zA-Z0-9_.-]*';

const ALLOWED: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/_ping$/],
  ['GET', /^\/containers\/json$/],
  ['GET', new RegExp(`^/containers/${ID}/json$`)],
  ['GET', new RegExp(`^/containers/${ID}/logs$`)],
  ['POST', new RegExp(`^/containers/${ID}/(start|stop|restart)$`)],
  ['POST', /^\/images\/create$/],
];

type Query = Record<string, string | number | boolean>;

interface RawResponse {
  status: number;
  body: Buffer;
}

// Non-TTY containers multiplex stdout/stderr into 8-byte-header frames;
// TTY containers return the raw stream, so pass anything else through as-is.
function parseDockerLogs(buf: Buffer): string {
  const isMultiplexed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!isMultiplexed) return buf.toString('utf8');

  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;
    lines.push(buf.subarray(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return lines.join('');
}

function errorMessage(res: RawResponse): string {
  const text = res.body.toString('utf8');
  try {
    const msg = (JSON.parse(text) as { message?: string }).message;
    if (msg) return `Docker ${res.status}: ${msg}`;
  } catch { /* not JSON */ }
  return `Docker ${res.status}: ${text}`;
}

export class DockerClient {
  constructor(private readonly socketPath: string) {}

  private async request(method: string, path: string, query: Query = {}, timeoutMs = 30_000): Promise<RawResponse> {
    if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) {
      throw new Error(`Docker API call not permitted: ${method} ${path}`);
    }

    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();

    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: this.socketPath, method, path: qs ? `${path}?${qs}` : path, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Docker request timed out: ${method} ${path}`)));
      req.on('error', reject);
      req.end();
    });
  }

  private async getJson<T>(path: string, query?: Query): Promise<T> {
    const res = await this.request('GET', path, query);
    if (res.status >= 400) throw new Error(errorMessage(res));
    return JSON.parse(res.body.toString('utf8')) as T;
  }

  // Returns false when Docker reports 304 (already in the requested state).
  private async containerAction(id: string, action: 'start' | 'stop' | 'restart', timeoutSec?: number): Promise<boolean> {
    const query: Query = timeoutSec != null ? { t: timeoutSec } : {};
    const waitMs = ((timeoutSec ?? 10) + 30) * 1000;
    const res = await this.request('POST', `/containers/${id}/${action}`, query, waitMs);
    if (res.status === 304) return false;
    if (res.status >= 400) throw new Error(errorMessage(res));
    return true;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/_ping', {}, 5_000);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async containers(all = true) {
    return this.getJson<unknown[]>('/containers/json', { all });
  }

  async inspectContainer(id: string) {
    return this.getJson<unknown>(`/containers/${id}/json`);
  }

  async logs(id: string, tail = 100): Promise<string> {
    const res = await this.request('GET', `/containers/${id}/logs`, { stdout: 1, stderr: 1, tail, timestamps: 1 });
    if (res.status >= 400) throw new Error(errorMessage(res));
    return parseDockerLogs(res.body);
  }

  start(id: string) {
    return this.containerAction(id, 'start');
  }

  stop(id: string, timeoutSec?: number) {
    return this.containerAction(id, 'stop', timeoutSec);
  }

  restart(id: string, timeoutSec?: number) {
    return this.containerAction(id, 'restart', timeoutSec);
  }

  // Pulls an image reference ("repo[:tag]" or "repo@digest"). The endpoint
  // streams newline-delimited JSON progress; failures arrive as an `error`
  // line inside a 200 response, so every line has to be checked.
  async pullImage(ref: string): Promise<string> {
    const res = await this.request('POST', '/images/create', { fromImage: ref }, 10 * 60_000);
    if (res.status >= 400) throw new Error(errorMessage(res));

    let lastStatus = '';
    for (const line of res.body.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let evt: { status?: string; error?: string };
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.error) throw new Error(`Pull of ${ref} failed: ${evt.error}`);
      if (evt.status) lastStatus = evt.status;
    }
    return lastStatus;
  }
}

export function makeDockerClient(socketPath: string): DockerClient | null {
  if (!existsSync(socketPath)) return null;
  return new DockerClient(socketPath);
}
