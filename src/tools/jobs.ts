import { TrueNASClient } from '../truenas-client.js';

type AnyObj = Record<string, unknown>;

function parseTs(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'number') return new Date(val * 1000).toISOString();
  if (typeof val === 'string') { const d = new Date(val); return isNaN(d.getTime()) ? null : d.toISOString(); }
  if (typeof val === 'object' && '$date' in (val as object)) return new Date((val as { $date: number }).$date).toISOString();
  return null;
}

function jobKey(job: AnyObj, cronById: Map<number, AnyObj>): string {
  const method = job['method'] as string;
  const args = job['arguments'] as unknown[] | null | undefined;
  if (method === 'cronjob.run' && Array.isArray(args) && args.length > 0) {
    const cron = cronById.get(args[0] as number);
    if (cron) return `cronjob:${args[0]}`;
  }
  return `method:${method}`;
}

function jobDescription(job: AnyObj, cronById: Map<number, AnyObj>): string {
  const method = job['method'] as string;
  const args = job['arguments'] as unknown[] | null | undefined;
  if (method === 'cronjob.run' && Array.isArray(args) && args.length > 0) {
    const cron = cronById.get(args[0] as number);
    if (cron) return (cron['description'] as string) || (cron['command'] as string);
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
    const key = jobKey(job, cronById);
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

  // Find the cron job matching the description
  let filter: unknown[][];
  let matchedDescription = description;

  const cronEntry = [...cronById.values()].find(
    (c) => (c['description'] as string) === description || (c['command'] as string) === description,
  );

  if (cronEntry) {
    filter = [['method', '=', 'cronjob.run'], ['arguments', 'rin', [cronEntry['id']]]];
  } else {
    filter = [['method', '=', description]];
    matchedDescription = description;
  }

  // Fallback: fetch all jobs and filter client-side (avoids API filter syntax uncertainty)
  const allJobs = await client.call<AnyObj[]>('core.get_jobs', [
    [],
    { order_by: ['-time_finished'], limit: 1000 },
  ]);

  const cronId = cronEntry ? (cronEntry['id'] as number) : null;
  const filtered = allJobs.filter((job) => {
    if (cronId !== null) {
      const args = job['arguments'] as unknown[] | null | undefined;
      return job['method'] === 'cronjob.run' && Array.isArray(args) && args[0] === cronId;
    }
    return job['method'] === description;
  });

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
