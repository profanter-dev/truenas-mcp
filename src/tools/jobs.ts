import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY, str, posInt } from './registry.js';
import { formatTs, nasTimezone, parseTs, redactArgs } from './utils.js';

type AnyObj = Record<string, unknown>;

function jobKey(job: AnyObj): string {
  const method = job['method'] as string;
  const args = job['arguments'] as unknown[] | null | undefined;
  if (method === 'cronjob.run' && Array.isArray(args) && args.length > 0) {
    // Use the cron ID regardless of whether the cron still exists, so deleted
    // cron jobs don't all collapse into one dedup bucket.
    return `cronjob:${args[0]}`;
  }
  return `method:${method}`;
}

function jobDescription(job: AnyObj, cronById: Map<number, AnyObj>): string {
  const method = job['method'] as string;
  const args = job['arguments'] as unknown[] | null | undefined;
  if (method === 'cronjob.run' && Array.isArray(args) && args.length > 0) {
    const cron = cronById.get(args[0] as number);
    if (cron) return (cron['description'] as string) || (cron['command'] as string);
    return `cronjob:${args[0]} (deleted)`;
  }
  return (job['description'] as string) || method;
}

async function fetchCronMap(client: TrueNASClient): Promise<Map<number, AnyObj>> {
  const crons = await client.call<AnyObj[]>('cronjob.query').catch(() => [] as AnyObj[]);
  const map = new Map<number, AnyObj>();
  for (const c of crons) map.set(c['id'] as number, c);
  return map;
}

const JOB_PAGE = 200;

// Newest-first jobs matching `filters` (server-side) and `keep` (client-side),
// paging until `limit` matches are found or the job table is exhausted.
async function queryJobs(
  client: TrueNASClient,
  filters: unknown[],
  limit: number,
  keep: (job: AnyObj) => boolean = () => true,
): Promise<AnyObj[]> {
  const out: AnyObj[] = [];
  for (let offset = 0; ; offset += JOB_PAGE) {
    const page = await client.call<AnyObj[]>('core.get_jobs', [
      filters,
      { order_by: ['-time_finished'], offset, limit: JOB_PAGE },
    ]);
    out.push(...page.filter(keep));
    if (out.length >= limit || page.length < JOB_PAGE) return out.slice(0, limit);
  }
}

// Call arguments with secrets masked; for mail.send just the message itself,
// so the text of an alert email can be read after the alert has cleared.
function jobArguments(job: AnyObj): unknown {
  const args = job['arguments'] as unknown[] | null | undefined;
  if (!Array.isArray(args) || !args.length) return null;
  if (job['method'] === 'mail.send' && args[0] && typeof args[0] === 'object') {
    const msg = args[0] as AnyObj;
    return redactArgs({ subject: msg['subject'], to: msg['to'], text: msg['text'] ?? msg['html'] ?? null });
  }
  return redactArgs(args);
}

// ── job_list ──────────────────────────────────────────────────────────────────

export async function jobList(client: TrueNASClient): Promise<string> {
  const [jobs, cronById, tz] = await Promise.all([
    client.call<AnyObj[]>('core.get_jobs', [
      [],
      { order_by: ['-time_finished'], limit: 500 },
    ]),
    fetchCronMap(client),
    nasTimezone(client),
  ]);

  // Group by unique job key, keep only the most recent run per key
  const seen = new Map<string, AnyObj>();
  for (const job of jobs) {
    const key = jobKey(job);
    if (!seen.has(key)) seen.set(key, job);
  }

  const result = [...seen.values()].map((job) => ({
    description: jobDescription(job, cronById),
    method: job['method'],
    last_run: formatTs(job['time_finished'], tz) ?? formatTs(job['time_started'], tz),
    last_state: job['state'],
    last_error: (job['error'] as string | null) || null,
  }));

  if (!result.length) return JSON.stringify({ message: 'No jobs found.' }, null, 2);

  return JSON.stringify(result, null, 2);
}

// ── job_history ───────────────────────────────────────────────────────────────

export async function jobHistory(client: TrueNASClient, description: string, limit: number): Promise<string> {
  const [cronById, tz] = await Promise.all([fetchCronMap(client), nasTimezone(client)]);

  const cronEntry = [...cronById.values()].find(
    (c) => (c['description'] as string) === description || (c['command'] as string) === description,
  );

  const matchedDescription = cronEntry
    ? ((cronEntry['description'] as string) || (cronEntry['command'] as string))
    : description;

  const cronId = cronEntry ? (cronEntry['id'] as number) : null;

  // Filter by method server-side to avoid scanning the full job table.
  // For cron jobs we filter by method only (can't filter by arguments server-side),
  // then narrow by cronId client-side, paging so frequent crons can't crowd out rare ones.
  const filtered = cronId !== null
    ? await queryJobs(client, [['method', '=', 'cronjob.run']], limit, (job) => {
        const args = job['arguments'] as unknown[] | null | undefined;
        return Array.isArray(args) && args[0] === cronId;
      })
    : await queryJobs(client, [['method', '=', description]], limit);

  if (!filtered.length) {
    return JSON.stringify({ message: `No job history found for: ${description}` }, null, 2);
  }

  const result = filtered.map((job) => {
    const started = parseTs(job['time_started']);
    const finished = parseTs(job['time_finished']);
    let duration_s: number | null = null;
    if (started && finished) {
      duration_s = Math.round((finished.getTime() - started.getTime()) / 1000);
    }
    return {
      id: job['id'],
      state: job['state'],
      time_started: formatTs(job['time_started'], tz),
      time_finished: formatTs(job['time_finished'], tz),
      duration_s,
      error: (job['error'] as string | null) || null,
      arguments: jobArguments(job),
    };
  });

  return JSON.stringify({ description: matchedDescription, runs: result }, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

export function jobTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'job_list',
        description: 'List all unique TrueNAS jobs with their last run status and timestamp. Use job_history to drill into a specific job\'s full run history.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => jobList(client),
    },
    {
      tool: {
        name: 'job_history',
        description: 'Get the run history for a specific job, identified by its description (as returned by job_list), with each run\'s arguments (secrets masked; for mail.send the email subject, recipients and body). TrueNAS keeps job history in memory only, so it starts at the last boot.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Job description as shown in job_list, e.g. "Update LED status"' },
            limit: { type: 'number', description: 'Number of runs to return (default 5)', default: 5 },
          },
          required: ['description'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => jobHistory(client, str(args, 'description'), posInt(args, 'limit', 5)),
    },
  ];
}
