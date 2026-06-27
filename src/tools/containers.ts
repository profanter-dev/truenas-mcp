import { DockerClient } from '../docker-client.js';

type AnyObj = Record<string, unknown>;

function shortId(id: unknown): string {
  return typeof id === 'string' ? id.slice(0, 12) : String(id);
}

function primaryName(names: unknown): string {
  if (!Array.isArray(names) || !names.length) return '?';
  return String(names[0]).replace(/^\//, '');
}

// ── container_list ─────────────────────────────────────────────────────────────

export async function containerList(docker: DockerClient): Promise<string> {
  const raw = await docker.containers(true) as AnyObj[];

  if (!raw.length) return JSON.stringify({ message: 'No containers found.' }, null, 2);

  const result = raw.map((c) => ({
    id: shortId(c['Id']),
    name: primaryName(c['Names']),
    image: c['Image'],
    state: c['State'],
    status: c['Status'],
    health: (c['Status'] as string)?.match(/\(([^)]+)\)/)?.[1] ?? null,
  }));

  result.sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify(result, null, 2);
}

// ── container_details ──────────────────────────────────────────────────────────

export async function containerDetails(docker: DockerClient, nameOrId: string): Promise<string> {
  // Resolve name → id if needed
  const all = await docker.containers(true) as AnyObj[];
  const match = all.find((c) => {
    const id = String(c['Id'] ?? '');
    const names = (c['Names'] as string[] | undefined) ?? [];
    return id.startsWith(nameOrId) ||
      names.some((n) => n.replace(/^\//, '') === nameOrId);
  });

  if (!match) return JSON.stringify({ error: `Container '${nameOrId}' not found.` }, null, 2);

  const detail = await docker.inspectContainer(String(match['Id'])) as AnyObj;
  const cfg = detail['Config'] as AnyObj ?? {};
  const state = detail['State'] as AnyObj ?? {};
  const net = (detail['NetworkSettings'] as AnyObj ?? {})['Networks'] as AnyObj ?? {};

  return JSON.stringify({
    id: shortId(detail['Id']),
    name: String(detail['Name'] ?? '').replace(/^\//, ''),
    image: cfg['Image'],
    state: state['Status'],
    running: state['Running'],
    started_at: state['StartedAt'],
    finished_at: state['FinishedAt'] === '0001-01-01T00:00:00Z' ? null : state['FinishedAt'],
    health: (state['Health'] as AnyObj | undefined)?.['Status'] ?? null,
    restart_count: detail['RestartCount'],
    ports: (detail['HostConfig'] as AnyObj ?? {})['PortBindings'],
    labels: cfg['Labels'] ?? {},
    env: (cfg['Env'] as string[] | undefined)?.filter((e) => !/(PASSWORD|SECRET|TOKEN|KEY)=/i.test(e)) ?? [],
    networks: Object.keys(net),
    mounts: (detail['Mounts'] as AnyObj[] | undefined)?.map((m) => ({
      type: m['Type'], source: m['Source'], destination: m['Destination'], mode: m['Mode'],
    })) ?? [],
  }, null, 2);
}

// ── container_logs ─────────────────────────────────────────────────────────────

export async function containerLogs(docker: DockerClient, nameOrId: string, tail = 100): Promise<string> {
  const all = await docker.containers(true) as AnyObj[];
  const match = all.find((c) => {
    const id = String(c['Id'] ?? '');
    const names = (c['Names'] as string[] | undefined) ?? [];
    return id.startsWith(nameOrId) ||
      names.some((n) => n.replace(/^\//, '') === nameOrId);
  });

  if (!match) return JSON.stringify({ error: `Container '${nameOrId}' not found.` }, null, 2);

  const logs = await docker.logs(String(match['Id']), tail);
  return logs || '(no log output)';
}
