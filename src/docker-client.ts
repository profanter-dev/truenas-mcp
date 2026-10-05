// Docker Engine client over the local unix socket.
//
// Mounting docker.sock is root-equivalent on the host (even with :ro), so this
// client is the security boundary: every request is checked against a fixed
// allowlist of method + path, query strings are built internally only, and
// there is deliberately no generic passthrough. Add an entry here only together
// with the tool that needs it.
//
// /containers/create is the one endpoint that could grant arbitrary access, so
// it is only reachable through createContainer(), whose body is always derived
// from an existing container's inspect output (see tools/updates.ts) — never
// from tool arguments.

import http from 'node:http';
import { existsSync } from 'node:fs';

const ID = '[a-zA-Z0-9][a-zA-Z0-9_.-]*';
// Image reference or ID: "nginx:latest", "ghcr.io/a/b:1.2", "repo@sha256:…", "sha256:…".
const REF = '[a-zA-Z0-9][a-zA-Z0-9_.\\-/:@]*';

const ALLOWED: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/_ping$/],
  ['GET', /^\/containers\/json$/],
  ['GET', new RegExp(`^/containers/${ID}/json$`)],
  ['GET', new RegExp(`^/containers/${ID}/logs$`)],
  ['GET', new RegExp(`^/containers/${ID}/stats$`)],
  ['GET', new RegExp(`^/containers/${ID}/top$`)],
  ['POST', new RegExp(`^/containers/${ID}/(start|stop|restart)$`)],
  ['POST', /^\/images\/create$/],
  ['GET', new RegExp(`^/images/${REF}/json$`)],
  ['GET', new RegExp(`^/distribution/${REF}/json$`)],
  ['POST', /^\/images\/prune$/],
  ['POST', /^\/containers\/create$/],
  ['POST', new RegExp(`^/containers/${ID}/rename$`)],
  ['DELETE', new RegExp(`^/containers/${ID}$`)],
];

// Docker pulls *every* tag of a repository when fromImage has no tag, so make
// the implicit ":latest" explicit.
export function normalizeRef(ref: string): string {
  if (ref.includes('@')) return ref;
  const last = ref.split('/').pop() ?? '';
  return last.includes(':') ? ref : `${ref}:latest`;
}

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

  private assertAllowed(method: string, path: string): void {
    const traversal = path.includes('..') || path.includes('//');
    if (traversal || !ALLOWED.some(([m, re]) => m === method && re.test(path))) {
      throw new Error(`Docker API call not permitted: ${method} ${path}`);
    }
  }

  private async request(
    method: string,
    path: string,
    query: Query = {},
    timeoutMs = 30_000,
    body?: unknown,
  ): Promise<RawResponse> {
    this.assertAllowed(method, path);
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: qs ? `${path}?${qs}` : path,
          timeout: timeoutMs,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Docker request timed out: ${method} ${path}`)));
      req.on('error', reject);
      req.end(payload);
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
    // Without an explicit timeout Docker uses the container's own StopTimeout
    // (compose stop_grace_period), so wait at least that long.
    let grace = timeoutSec ?? 10;
    if (timeoutSec == null && action !== 'start') {
      const cfg = (await this.inspectContainer(id) as { Config?: { StopTimeout?: number } }).Config;
      grace = cfg?.StopTimeout ?? 10;
    }
    const waitMs = (grace + 30) * 1000;
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
    ref = normalizeRef(ref);
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

  // Reads `count` consecutive samples (one per second) from the streaming stats
  // endpoint; the second sample's precpu_stats cover the interval since the first.
  async statsSamples(id: string, count = 2): Promise<Array<Record<string, unknown>>> {
    const path = `/containers/${id}/stats`;
    this.assertAllowed('GET', path);
    return new Promise((resolve, reject) => {
      const samples: Array<Record<string, unknown>> = [];
      let buf = '';
      const req = http.request({ socketPath: this.socketPath, method: 'GET', path: `${path}?stream=true`, timeout: 15_000 }, (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => reject(new Error(errorMessage({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))));
          return;
        }
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              try {
                samples.push(JSON.parse(line));
              } catch {
                req.destroy();
                return reject(new Error(`Unreadable stats sample from Docker for ${id}`));
              }
            }
            if (samples.length >= count) {
              req.destroy();
              return resolve(samples);
            }
          }
        });
        res.on('end', () => (samples.length ? resolve(samples) : reject(new Error('Stats stream ended without data'))));
      });
      req.on('timeout', () => req.destroy(new Error(`Docker stats timed out for ${id}`)));
      req.on('error', (e) => { if (samples.length < count) reject(e); });
      req.end();
    });
  }

  // `ps` columns are fixed here; tools cannot pass their own ps arguments.
  async top(id: string): Promise<{ Titles: string[]; Processes: string[][] }> {
    return this.getJson(`/containers/${id}/top`, { ps_args: '-eo pid,ppid,user,pcpu,pmem,rss,nlwp,etime,stat,args' });
  }

  async inspectImage(ref: string) {
    return this.getJson<Record<string, unknown>>(`/images/${ref}/json`);
  }

  // Asks the daemon for the registry's current manifest digest of a reference.
  async registryDigest(ref: string): Promise<string> {
    const res = await this.request('GET', `/distribution/${normalizeRef(ref)}/json`, {}, 60_000);
    if (res.status >= 400) throw new Error(errorMessage(res));
    const digest = (JSON.parse(res.body.toString('utf8')) as { Descriptor?: { digest?: string } }).Descriptor?.digest;
    if (!digest) throw new Error(`Registry returned no digest for ${ref}`);
    return digest;
  }

  async pruneImages(all: boolean): Promise<{ ImagesDeleted?: Array<Record<string, string>> | null; SpaceReclaimed?: number }> {
    const query: Query = all ? { filters: JSON.stringify({ dangling: ['false'] }) } : {};
    const res = await this.request('POST', '/images/prune', query, 5 * 60_000);
    if (res.status >= 400) throw new Error(errorMessage(res));
    return JSON.parse(res.body.toString('utf8'));
  }

  async createContainer(name: string, body: Record<string, unknown>): Promise<string> {
    const res = await this.request('POST', '/containers/create', { name }, 60_000, body);
    if (res.status >= 400) throw new Error(errorMessage(res));
    return (JSON.parse(res.body.toString('utf8')) as { Id: string }).Id;
  }

  async renameContainer(id: string, name: string): Promise<void> {
    const res = await this.request('POST', `/containers/${id}/rename`, { name });
    if (res.status >= 400) throw new Error(errorMessage(res));
  }

  // Never passes v=1 or force=1: volumes are kept and running containers refused.
  async removeContainer(id: string): Promise<void> {
    const res = await this.request('DELETE', `/containers/${id}`);
    if (res.status >= 400) throw new Error(errorMessage(res));
  }
}

export function makeDockerClient(socketPath: string): DockerClient | null {
  if (!existsSync(socketPath)) return null;
  return new DockerClient(socketPath);
}
