// Scheduled and data-protection tasks: periodic snapshot tasks, replication
// tasks, cron jobs, plus the middleware audit log. All read-only.

import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY, optStr, optDate, posInt } from './registry.js';
import { formatTs, nasTimezone, redactArgs, redactCommand } from './utils.js';

type AnyObj = Record<string, unknown>;

// TrueNAS schedules are cron fields plus an optional begin/end window.
function cronSchedule(schedule: unknown): object | null {
  if (!schedule || typeof schedule !== 'object') return null;
  const s = schedule as AnyObj;
  const cron = ['minute', 'hour', 'dom', 'month', 'dow'].map((k) => s[k] ?? '*').join(' ');
  const windowed = s['begin'] && s['end'] && !(s['begin'] === '00:00' && s['end'] === '23:59');
  return windowed ? { cron, between: `${s['begin']}-${s['end']}` } : { cron };
}

// Task `state` objects: {state, datetime?, error?, warnings?, last_snapshot?}.
function lastRun(state: unknown, tz: string): object | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as AnyObj;
  const warnings = s['warnings'] as unknown[] | undefined;
  return {
    state: s['state'] ?? null,
    at: formatTs(s['datetime'], tz),
    ...(s['error'] ? { error: s['error'] } : {}),
    ...(warnings?.length ? { warnings } : {}),
    ...(s['last_snapshot'] ? { last_snapshot: s['last_snapshot'] } : {}),
  };
}

// ── snapshot_task_list ─────────────────────────────────────────────────────────

export async function snapshotTaskList(client: TrueNASClient): Promise<string> {
  const [tasks, tz] = await Promise.all([
    client.call<AnyObj[]>('pool.snapshottask.query'),
    nasTimezone(client),
  ]);

  if (!tasks.length) return JSON.stringify({ message: 'No periodic snapshot tasks configured.' }, null, 2);

  return JSON.stringify(tasks.map((t) => ({
    id: t['id'],
    dataset: t['dataset'],
    recursive: t['recursive'],
    exclude: (t['exclude'] as unknown[] | undefined)?.length ? t['exclude'] : undefined,
    naming_schema: t['naming_schema'],
    retention: `${t['lifetime_value']} ${t['lifetime_unit']}`,
    schedule: cronSchedule(t['schedule']),
    enabled: t['enabled'],
    allow_empty: t['allow_empty'],
    last_run: lastRun(t['state'], tz),
  })), null, 2);
}

// ── replication_task_list ──────────────────────────────────────────────────────

export async function replicationTaskList(client: TrueNASClient): Promise<string> {
  const [tasks, tz] = await Promise.all([
    client.call<AnyObj[]>('replication.query'),
    nasTimezone(client),
  ]);

  if (!tasks.length) return JSON.stringify({ message: 'No replication tasks configured.' }, null, 2);

  // Picked field by field: the raw task carries SSH credentials and encryption keys.
  return JSON.stringify(tasks.map((t) => {
    const ssh = t['ssh_credentials'] as AnyObj | null | undefined;
    const snapTasks = (t['periodic_snapshot_tasks'] as AnyObj[] | undefined) ?? [];
    return {
      id: t['id'],
      name: t['name'],
      direction: t['direction'],
      transport: t['transport'],
      ssh_credentials: ssh ? { id: ssh['id'], name: ssh['name'] } : null,
      source_datasets: t['source_datasets'],
      target_dataset: t['target_dataset'],
      recursive: t['recursive'],
      periodic_snapshot_tasks: snapTasks.map((p) => ({ id: p['id'], dataset: p['dataset'], naming_schema: p['naming_schema'] })),
      naming_schema: (t['naming_schema'] as unknown[] | undefined)?.length ? t['naming_schema'] : undefined,
      also_include_naming_schema: (t['also_include_naming_schema'] as unknown[] | undefined)?.length
        ? t['also_include_naming_schema'] : undefined,
      name_regex: t['name_regex'] || undefined,
      auto: t['auto'],
      schedule: cronSchedule(t['schedule']),
      retention_policy: t['retention_policy'],
      retention: t['retention_policy'] === 'CUSTOM' ? `${t['lifetime_value']} ${t['lifetime_unit']}` : undefined,
      enabled: t['enabled'],
      last_run: lastRun(t['state'], tz),
    };
  }), null, 2);
}

// ── cronjob_list ───────────────────────────────────────────────────────────────

export async function cronjobList(client: TrueNASClient): Promise<string> {
  const jobs = await client.call<AnyObj[]>('cronjob.query');

  if (!jobs.length) return JSON.stringify({ message: 'No cron jobs configured.' }, null, 2);

  return JSON.stringify(jobs.map((j) => ({
    id: j['id'],
    description: j['description'] || null,
    command: redactCommand(String(j['command'] ?? '')),
    user: j['user'],
    schedule: cronSchedule(j['schedule']),
    enabled: j['enabled'],
    hide_stdout: j['stdout'],
    hide_stderr: j['stderr'],
  })), null, 2);
}

// ── audit_query ────────────────────────────────────────────────────────────────

const AUDIT_DETAILS_MAX = 400;

function auditDetails(data: AnyObj): unknown {
  const json = JSON.stringify(redactArgs(data));
  return json.length > AUDIT_DETAILS_MAX ? `${json.slice(0, AUDIT_DETAILS_MAX)}… [truncated]` : redactArgs(data);
}

export interface AuditFilter {
  services: string[];
  event?: string;
  method?: string;
  username?: string;
  since?: Date;
  before?: Date;
}

export async function auditQuery(client: TrueNASClient, filter: AuditFilter, limit: number): Promise<string> {
  const conditions: unknown[] = [];
  if (filter.event) conditions.push(['event', '=', filter.event]);
  if (filter.method) conditions.push(['event_data.method', '=', filter.method]);
  if (filter.username) conditions.push(['username', '=', filter.username]);
  if (filter.since) conditions.push(['message_timestamp', '>=', Math.floor(filter.since.getTime() / 1000)]);
  if (filter.before) conditions.push(['message_timestamp', '<', Math.floor(filter.before.getTime() / 1000)]);

  const tz = await nasTimezone(client);
  let entries: AnyObj[];
  try {
    entries = await client.call<AnyObj[]>('audit.query', [{
      services: filter.services,
      'query-filters': conditions,
      'query-options': { order_by: ['-message_timestamp'], limit },
    }]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not authori[sz]ed|permission|EACCES|EPERM/i.test(msg)) {
      return JSON.stringify({
        error: 'The API key cannot read the audit log. Its user needs the SYSTEM_AUDIT_READ role (e.g. via the Read-only Administrator privilege).',
        detail: msg,
      }, null, 2);
    }
    throw e;
  }

  if (!entries.length) return JSON.stringify({ message: 'No matching audit entries.' }, null, 2);

  return JSON.stringify(entries.map((a) => {
    const data = (a['event_data'] as AnyObj | null | undefined) ?? {};
    const creds = data['credentials'] as AnyObj | null | undefined;
    // Method calls and logins have a known shape; anything else (SHUTDOWN
    // reasons, SUDO commands, kernel audit records) is passed through, trimmed.
    const known = 'method' in data || 'credentials' in data;
    return {
      time: formatTs(a['message_timestamp'], tz),
      service: a['service'],
      event: a['event'],
      method: data['method'] ?? undefined,
      description: data['description'] ?? undefined,
      credential_type: creds?.['credentials'] ?? undefined,
      error: data['error'] ?? undefined,
      details: !known && Object.keys(data).length ? auditDetails(data) : undefined,
      username: a['username'],
      address: a['address'],
      success: a['success'],
    };
  }), null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

export function taskTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'snapshot_task_list',
        description: 'List periodic ZFS snapshot tasks: dataset, recursive/exclude, naming schema, retention, schedule (cron), enabled, and last run state. Tasks sharing a naming schema on the same dataset also share snapshots.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => snapshotTaskList(client),
    },
    {
      tool: {
        name: 'replication_task_list',
        description: 'List ZFS replication tasks: direction, transport, source/target datasets, linked snapshot tasks and naming schemas, schedule, retention, enabled, and last run state. Credentials are reduced to their name.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => replicationTaskList(client),
    },
    {
      tool: {
        name: 'cronjob_list',
        description: 'List TrueNAS cron jobs: description, command (credentials redacted), user, schedule (cron), enabled. Use job_history with the description for past runs.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => cronjobList(client),
    },
    {
      tool: {
        name: 'audit_query',
        description: 'Query the TrueNAS audit log, newest first: who did what, when, from which address, and whether it succeeded. MIDDLEWARE covers logins (AUTHENTICATION/LOGOUT), audited method calls (METHOD_CALL) and UI/API shutdowns and reboots (events SHUTDOWN/REBOOT, with reason); SYSTEM covers OS-level records (e.g. /sbin/poweroff); SUDO covers sudo commands. Unlike job history, the audit log survives reboots. To explain downtime, query entries before the boot_time from system_info: no SHUTDOWN/REBOOT event points to power loss, a crash or a hardware reset.',
        inputSchema: {
          type: 'object',
          properties: {
            services: {
              type: 'array',
              items: { type: 'string', enum: ['MIDDLEWARE', 'SMB', 'SUDO', 'SYSTEM'] },
              description: 'Audit services to search (default ["MIDDLEWARE"])',
            },
            event: { type: 'string', description: 'Exact event type, e.g. "METHOD_CALL", "AUTHENTICATION", "LOGOUT", "SHUTDOWN", "REBOOT"' },
            method: { type: 'string', description: 'Exact middleware method, e.g. "system.reboot"' },
            username: { type: 'string', description: 'Exact username' },
            since: { type: 'string', description: 'Only entries at or after this ISO date/time (a date alone means midnight UTC)' },
            before: { type: 'string', description: 'Only entries before this ISO date/time, e.g. the boot_time from system_info' },
            limit: { type: 'number', description: 'Max entries to return (default 50)', default: 50 },
          },
        },
        annotations: READ_ONLY,
      },
      handler: (args) => {
        const services = Array.isArray(args['services']) && args['services'].length
          ? (args['services'] as unknown[]).map(String)
          : ['MIDDLEWARE'];
        return auditQuery(client, {
          services,
          event: optStr(args, 'event'),
          method: optStr(args, 'method'),
          username: optStr(args, 'username'),
          since: optDate(args, 'since'),
          before: optDate(args, 'before'),
        }, posInt(args, 'limit', 50));
      },
    },
  ];
}
