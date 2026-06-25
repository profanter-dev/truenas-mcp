import { TrueNASClient } from '../truenas-client.js';

type AnyObj = Record<string, unknown>;

function parseTs(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'number') return new Date(val * 1000).toISOString();
  if (typeof val === 'string') { const d = new Date(val); return isNaN(d.getTime()) ? null : d.toISOString(); }
  if (typeof val === 'object' && '$date' in (val as object)) return new Date((val as { $date: number }).$date).toISOString();
  return null;
}

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

// ── job_list ──────────────────────────────────────────────────────────────────

export async function jobList(client: TrueNASClient): Promise<string> {
  const [jobs, cronById] = await Promise.all([
    client.call<AnyObj[]>('core.get_jobs', [
      [],
      { order_by: ['-time_finished'], limit: 500 },
    ]),
    fetchCronMap(client),
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
    last_run: parseTs(job['time_finished']) ?? parseTs(job['time_started']),
    last_state: job['state'],
    last_error: (job['error'] as string | null) || null,
  }));

  if (!result.length) return JSON.stringify({ message: 'No jobs found.' }, null, 2);

  return JSON.stringify(result, null, 2);
}

// ── job_history ───────────────────────────────────────────────────────────────

export async function jobHistory(client: TrueNASClient, description: string, limit: number): Promise<string> {
  const cronById = await fetchCronMap(client);

  const cronEntry = [...cronById.values()].find(
    (c) => (c['description'] as string) === description || (c['command'] as string) === description,
  );

  const matchedDescription = cronEntry
    ? ((cronEntry['description'] as string) || (cronEntry['command'] as string))
    : description;

  const cronId = cronEntry ? (cronEntry['id'] as number) : null;

  // Filter by method server-side to avoid scanning the full job table.
  // For cron jobs we filter by method only (can't filter by arguments server-side),
  // then narrow by cronId client-side.
  const apiFilter = cronId !== null
    ? [['method', '=', 'cronjob.run']]
    : [['method', '=', description]];

  const jobs = await client.call<AnyObj[]>('core.get_jobs', [
    apiFilter,
    { order_by: ['-time_finished'], limit: Math.max(limit * 10, 100) },
  ]);

  const filtered = cronId !== null
    ? jobs.filter((job) => {
        const args = job['arguments'] as unknown[] | null | undefined;
        return Array.isArray(args) && args[0] === cronId;
      })
    : jobs;

  if (!filtered.length) {
    return JSON.stringify({ message: `No job history found for: ${description}` }, null, 2);
  }

  const result = filtered.slice(0, limit).map((job) => {
    const started = parseTs(job['time_started']);
    const finished = parseTs(job['time_finished']);
    let duration_s: number | null = null;
    if (started && finished) {
      duration_s = Math.round((new Date(finished).getTime() - new Date(started).getTime()) / 1000);
    }
    return {
      id: job['id'],
      state: job['state'],
      time_started: started,
      time_finished: finished,
      duration_s,
      error: (job['error'] as string | null) || null,
    };
  });

  return JSON.stringify({ description: matchedDescription, runs: result }, null, 2);
}
