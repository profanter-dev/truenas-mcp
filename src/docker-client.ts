// Docker Engine HTTP client — connects to a docker-socket-proxy behind Traefik.
// Disabled when DOCKER_PROXY_URL is not set.

function parseDockerLogs(buf: Buffer): string {
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

export class DockerClient {
  private readonly auth: string;

  constructor(
    private readonly baseUrl: string,
    user: string,
    pass: string,
  ) {
    this.auth = Buffer.from(`${user}:${pass}`).toString('base64');
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Basic ${this.auth}` },
    });
    if (!res.ok) {
      throw new Error(`Docker proxy ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  async containers(all = true) {
    return this.get<unknown[]>(`/containers/json?all=${all}`);
  }

  async inspectContainer(id: string) {
    return this.get<unknown>(`/containers/${id}/json`);
  }

  async logs(id: string, tail = 100): Promise<string> {
    const url = `${this.baseUrl}/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${this.auth}` },
    });
    if (!res.ok) throw new Error(`Docker proxy ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return parseDockerLogs(buf);
  }
}

export function makeDockerClient(): DockerClient | null {
  const url = process.env['DOCKER_PROXY_URL'];
  const user = process.env['DOCKER_PROXY_USER'];
  const pass = process.env['DOCKER_PROXY_PASS'];
  if (!url || !user || !pass) return null;
  return new DockerClient(url.replace(/\/$/, ''), user, pass);
}
