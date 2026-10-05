import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { DockerClient } from '../docker-client.js';
import { ToolDef, READ_ONLY, str, posInt } from './registry.js';

type AnyObj = Record<string, unknown>;

export function shortId(id: unknown): string {
  return typeof id === 'string' ? id.slice(0, 12) : String(id);
}

export function primaryName(names: unknown): string {
  if (!Array.isArray(names) || !names.length) return '?';
  return String(names[0]).replace(/^\//, '');
}

// Docker only reports health inside Status for containers with a healthcheck,
// e.g. "Up 3 days (healthy)". Other parentheses ("Exited (0) …") are exit codes.
function healthFromStatus(status: unknown): string | null {
  if (typeof status !== 'string') return null;
  return status.match(/\((healthy|unhealthy|health: starting)\)/)?.[1] ?? null;
}

export async function resolveContainer(docker: DockerClient, nameOrId: string): Promise<AnyObj | null> {
  if (!nameOrId) return null;
  const all = await docker.containers(true) as AnyObj[];
  return all.find((c) => {
    const id = String(c['Id'] ?? '');
    const names = (c['Names'] as string[] | undefined) ?? [];
    return id.startsWith(nameOrId) ||
      names.some((n) => n.replace(/^\//, '') === nameOrId);
  }) ?? null;
}

// Labels carry credentials too, e.g. Traefik basic-auth middlewares store
// htpasswd hashes in `...basicauth.users`. Keep the key, mask the value.
const SENSITIVE_LABEL_KEY = /(password|passwd|secret|token|key|credential|(basic|digest)auth\.users)/i;
const HASH_VALUE = /\$(apr1|2[abxy]?|[156])\$|\{SHA\}/;

function redactLabels(labels: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries((labels as Record<string, string> | null) ?? {}).map(([k, v]) =>
      [k, SENSITIVE_LABEL_KEY.test(k) || HASH_VALUE.test(String(v)) ? '[redacted]' : v]),
  );
}

function notFound(nameOrId: string): string {
  return JSON.stringify({ error: `Container '${nameOrId}' not found.` }, null, 2);
}

// Our own container ID: Docker bind-mounts /etc/hostname etc. from
// /var/lib/docker/containers/<id>/, which shows up in mountinfo. Falls back to
// the default hostname (short ID) if mountinfo is unavailable.
let selfId: string | null | undefined;
function ownContainerId(): string | null {
  if (selfId !== undefined) return selfId;
  try {
    const m = readFileSync('/proc/self/mountinfo', 'utf8').match(/\/containers\/([0-9a-f]{64})\//);
    selfId = m?.[1] ?? null;
  } catch {
    selfId = null;
  }
  if (!selfId && /^[0-9a-f]{12}$/.test(hostname())) selfId = hostname();
  return selfId;
}

export function isSelf(id: string): boolean {
  const own = ownContainerId();
  return own != null && (id.startsWith(own) || own.startsWith(id));
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
    health: healthFromStatus(c['Status']),
  }));

  result.sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify(result, null, 2);
}

// ── container_details ──────────────────────────────────────────────────────────

export async function containerDetails(docker: DockerClient, nameOrId: string): Promise<string> {
  const match = await resolveContainer(docker, nameOrId);
  if (!match) return notFound(nameOrId);

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
    labels: redactLabels(cfg['Labels']),
    env: (cfg['Env'] as string[] | undefined)?.filter((e) => !/(PASSWORD|SECRET|TOKEN|KEY)=/i.test(e)) ?? [],
    networks: Object.keys(net),
    mounts: (detail['Mounts'] as AnyObj[] | undefined)?.map((m) => ({
      type: m['Type'], source: m['Source'], destination: m['Destination'], mode: m['Mode'],
    })) ?? [],
  }, null, 2);
}

// ── container_logs ─────────────────────────────────────────────────────────────

export async function containerLogs(docker: DockerClient, nameOrId: string, tail = 100): Promise<string> {
  const match = await resolveContainer(docker, nameOrId);
  if (!match) return notFound(nameOrId);

  const logs = await docker.logs(String(match['Id']), tail);
  return logs || '(no log output)';
}

// ── container_start / container_stop / container_restart ──────────────────────

type Action = 'start' | 'stop' | 'restart';

export async function containerAction(
  docker: DockerClient,
  action: Action,
  nameOrId: string,
  timeoutSec?: number,
): Promise<string> {
  const match = await resolveContainer(docker, nameOrId);
  if (!match) return notFound(nameOrId);

  const id = String(match['Id']);
  const name = primaryName(match['Names']);

  if (action !== 'start' && isSelf(id)) {
    throw new Error(`Refusing to ${action} '${name}': it is the container running this MCP server.`);
  }

  const changed = action === 'start' ? await docker.start(id)
    : action === 'stop' ? await docker.stop(id, timeoutSec)
    : await docker.restart(id, timeoutSec);

  const after = await docker.inspectContainer(id) as AnyObj;
  const state = after['State'] as AnyObj ?? {};

  return JSON.stringify({
    id: shortId(id),
    name,
    action,
    changed,
    ...(changed ? {} : { note: `Container was already ${action === 'start' ? 'running' : 'stopped'}.` }),
    state: state['Status'],
    health: (state['Health'] as AnyObj | undefined)?.['Status'] ?? null,
  }, null, 2);
}

// ── image_pull ─────────────────────────────────────────────────────────────────

export async function imagePull(docker: DockerClient, nameOrId: string): Promise<string> {
  const match = await resolveContainer(docker, nameOrId);
  if (!match) return notFound(nameOrId);

  const detail = await docker.inspectContainer(String(match['Id'])) as AnyObj;
  const cfg = detail['Config'] as AnyObj ?? {};
  const labels = cfg['Labels'] as Record<string, string> | undefined ?? {};
  const image = String(cfg['Image'] ?? '');

  if (!image || /^(sha256:)?[0-9a-f]{12,64}$/.test(image)) {
    throw new Error(`Container '${nameOrId}' was created from an image ID (${image || 'unknown'}), not a pullable reference.`);
  }

  const status = await docker.pullImage(image);
  const project = labels['com.docker.compose.project'];

  return JSON.stringify({
    container: primaryName(match['Names']),
    image,
    status,
    note: 'The running container is unchanged. Recreate it to use the pulled image'
      + (project ? ` (e.g. redeploy the "${project}" stack in Dockge or run \`docker compose up -d\`).` : '.'),
  }, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

const NAME_OR_ID = { type: 'string', description: 'Container name or short ID as shown in container_list' };
const STOP_TIMEOUT = { type: 'number', description: 'Seconds to wait for a graceful stop before killing (Docker default: 10)' };

export function containerTools(docker: DockerClient, opts: { write: boolean }): ToolDef[] {
  const read: ToolDef[] = [
    {
      tool: {
        name: 'container_list',
        description: 'List all Docker containers (running and stopped) with their state and health status.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => containerList(docker),
    },
    {
      tool: {
        name: 'container_details',
        description: 'Full details for a single Docker container: image, state, ports, mounts, networks, labels. Environment variables and labels with secrets are redacted.',
        inputSchema: { type: 'object', properties: { name_or_id: NAME_OR_ID }, required: ['name_or_id'] },
        annotations: READ_ONLY,
      },
      handler: (args) => containerDetails(docker, str(args, 'name_or_id')),
    },
    {
      tool: {
        name: 'container_logs',
        description: 'Retrieve recent log output for a Docker container.',
        inputSchema: {
          type: 'object',
          properties: {
            name_or_id: NAME_OR_ID,
            tail: { type: 'number', description: 'Number of log lines to return (default 100)', default: 100 },
          },
          required: ['name_or_id'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => containerLogs(docker, str(args, 'name_or_id'), posInt(args, 'tail', 100)),
    },
  ];

  if (!opts.write) return read;

  const timeout = (args: Record<string, unknown>) =>
    args['timeout'] == null ? undefined : Math.max(0, Math.floor(Number(args['timeout'])) || 0);

  return [
    ...read,
    {
      tool: {
        name: 'container_start',
        description: 'Start a stopped Docker container.',
        inputSchema: { type: 'object', properties: { name_or_id: NAME_OR_ID }, required: ['name_or_id'] },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      handler: (args) => containerAction(docker, 'start', str(args, 'name_or_id')),
    },
    {
      tool: {
        name: 'container_stop',
        description: 'Stop a running Docker container (SIGTERM, then SIGKILL after the timeout). Refuses to stop the MCP server\'s own container.',
        inputSchema: {
          type: 'object',
          properties: { name_or_id: NAME_OR_ID, timeout: STOP_TIMEOUT },
          required: ['name_or_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      handler: (args) => containerAction(docker, 'stop', str(args, 'name_or_id'), timeout(args)),
    },
    {
      tool: {
        name: 'container_restart',
        description: 'Restart a Docker container. Refuses to restart the MCP server\'s own container.',
        inputSchema: {
          type: 'object',
          properties: { name_or_id: NAME_OR_ID, timeout: STOP_TIMEOUT },
          required: ['name_or_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      handler: (args) => containerAction(docker, 'restart', str(args, 'name_or_id'), timeout(args)),
    },
    {
      tool: {
        name: 'image_pull',
        description: 'Pull the latest version of the image a container was created from. Only downloads the image — the running container keeps using the old one until it is recreated (e.g. by redeploying its Compose/Dockge stack).',
        inputSchema: { type: 'object', properties: { name_or_id: NAME_OR_ID }, required: ['name_or_id'] },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      handler: (args) => imagePull(docker, str(args, 'name_or_id')),
    },
  ];
}
