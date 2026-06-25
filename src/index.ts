#!/usr/bin/env node

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { TrueNASClient } from './truenas-client.js';
import { poolList, poolDetails, diskList, diskDetails, datasetList, datasetDetails } from './tools/storage.js';
import { jobList, jobHistory } from './tools/jobs.js';
import { alertList } from './tools/alerts.js';
import { shareList, shareDetails } from './tools/shares.js';
import { systemInfo } from './tools/system.js';
import { serviceList, serviceDetails } from './tools/services.js';
import { snapshotList, snapshotDetails } from './tools/snapshots.js';

const host = process.env['TRUENAS_HOST'];
const apiKey = process.env['TRUENAS_API_KEY'];
const insecure = process.env['TRUENAS_INSECURE'] === 'true';

if (!host || !apiKey) {
  process.stderr.write(
    'Error: TRUENAS_HOST and TRUENAS_API_KEY environment variables must be set\n',
  );
  process.exit(1);
}

const client = new TrueNASClient(host, apiKey, insecure);

const server = new Server(
  { name: 'truenas-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const TOOLS: Tool[] = [
  {
    name: 'pool_list',
    description: 'List all ZFS pools with their status, health, and capacity (size/allocated/free).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pool_details',
    description: 'Get full details for a single ZFS pool: health, capacity, last scrub, and all datasets with usage.',
    inputSchema: {
      type: 'object',
      properties: {
        pool_name: { type: 'string', description: 'Name of the pool, e.g. "media" or "apps"' },
      },
      required: ['pool_name'],
    },
  },
  {
    name: 'disk_list',
    description: 'List all disks with model, type, pool assignment, temperature, SMART last result, and ZFS error counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'disk_details',
    description: 'Full details for a single disk: serial, size, temperature, SMART test history, vdev assignment, and ZFS errors.',
    inputSchema: {
      type: 'object',
      properties: {
        disk_name: { type: 'string', description: 'Disk name, e.g. "sda" or "nvme0n1"' },
      },
      required: ['disk_name'],
    },
  },
  {
    name: 'dataset_list',
    description: 'List all ZFS datasets with used/available space. Optionally filter by pool.',
    inputSchema: {
      type: 'object',
      properties: {
        pool_name: { type: 'string', description: 'Optional pool name to filter datasets, e.g. "media"' },
      },
    },
  },
  {
    name: 'dataset_details',
    description: 'Get full properties for a single ZFS dataset: size, compression, dedup, quota, and more.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string', description: 'Dataset ID, e.g. "media/tv" or "apps/ix-applications"' },
      },
      required: ['dataset_id'],
    },
  },
  {
    name: 'job_list',
    description: 'List all unique TrueNAS jobs with their last run status and timestamp. Use job_history to drill into a specific job\'s full run history.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'job_history',
    description: 'Get the run history for a specific job, identified by its description (as returned by job_list).',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Job description as shown in job_list, e.g. "Update LED status"' },
        limit: { type: 'number', description: 'Number of runs to return (default 5)', default: 5 },
      },
      required: ['description'],
    },
  },
  {
    name: 'system_info',
    description: 'Get TrueNAS system information: hostname, version, CPU, memory, uptime, load average, and timezone.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'service_list',
    description: 'List all TrueNAS services (SMB, NFS, SSH, etc.) with their running state and whether they are enabled at boot.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'service_details',
    description: 'Get full details for a specific TrueNAS service.',
    inputSchema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service name as shown in service_list, e.g. "cifs", "nfs", "ssh"' },
      },
      required: ['service_name'],
    },
  },
  {
    name: 'snapshot_list',
    description: 'List ZFS snapshots ordered by most recent. Optionally filter by dataset.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string', description: 'Optional dataset to filter by, e.g. "media/tv"' },
        limit: { type: 'number', description: 'Max number of snapshots to return (default 20)', default: 20 },
        ignore_boot_pool: { type: 'boolean', description: 'Exclude boot-pool snapshots (default true)', default: true },
      },
    },
  },
  {
    name: 'snapshot_details',
    description: 'Get full details for a specific ZFS snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'Snapshot ID as returned by snapshot_list, e.g. "media/tv@auto-2026-06-01"' },
      },
      required: ['snapshot_id'],
    },
  },
  {
    name: 'share_list',
    description: 'List all configured SMB and NFS shares with their path, enabled state, and comment.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'share_details',
    description: 'Get full details for a specific SMB or NFS share.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['smb', 'nfs'], description: 'Share protocol type' },
        id: { type: 'number', description: 'Share ID as returned by share_list' },
      },
      required: ['type', 'id'],
    },
  },
  {
    name: 'alert_list',
    description: 'List all active TrueNAS alerts sorted by severity (CRITICAL → WARNING → INFO). Datetimes shown in Europe/Rome timezone.',
    inputSchema: { type: 'object', properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  function ok(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }
  function err(text: string) {
    return { content: [{ type: 'text' as const, text }], isError: true };
  }
  async function run(fn: () => Promise<string>) {
    try {
      return ok(await fn());
    } catch (e) {
      return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  switch (name) {
    case 'pool_list':
      return run(() => poolList(client));

    case 'pool_details': {
      const poolName = String((args as Record<string, unknown>)?.['pool_name'] ?? '');
      return run(() => poolDetails(client, poolName));
    }

    case 'disk_list':
      return run(() => diskList(client));

    case 'disk_details': {
      const diskName = String((args as Record<string, unknown>)?.['disk_name'] ?? '');
      return run(() => diskDetails(client, diskName));
    }

    case 'dataset_list': {
      const poolName = (args as Record<string, unknown>)?.['pool_name'] as string | undefined;
      return run(() => datasetList(client, poolName));
    }

    case 'dataset_details': {
      const datasetId = String((args as Record<string, unknown>)?.['dataset_id'] ?? '');
      return run(() => datasetDetails(client, datasetId));
    }

    case 'system_info':
      return run(() => systemInfo(client));

    case 'service_list':
      return run(() => serviceList(client));

    case 'service_details': {
      const serviceName = String((args as Record<string, unknown>)?.['service_name'] ?? '');
      return run(() => serviceDetails(client, serviceName));
    }

    case 'snapshot_list': {
      const a = args as Record<string, unknown>;
      const datasetId = a?.['dataset_id'] as string | undefined;
      const limit = Math.max(1, Number(a?.['limit']) || 20);
      const ignoreBootPool = a?.['ignore_boot_pool'] !== false;
      return run(() => snapshotList(client, datasetId, limit, ignoreBootPool));
    }

    case 'snapshot_details': {
      const snapshotId = String((args as Record<string, unknown>)?.['snapshot_id'] ?? '');
      return run(() => snapshotDetails(client, snapshotId));
    }

    case 'share_list':
      return run(() => shareList(client));

    case 'share_details': {
      const type = String((args as Record<string, unknown>)?.['type'] ?? '');
      const id = Number((args as Record<string, unknown>)?.['id']);
      return run(() => shareDetails(client, type, id));
    }

    case 'job_list':
      return run(() => jobList(client));

    case 'job_history': {
      const description = String((args as Record<string, unknown>)?.['description'] ?? '');
      const limit = Math.max(1, Number((args as Record<string, unknown>)?.['limit']) || 5);
      return run(() => jobHistory(client, description, limit));
    }

    case 'alert_list':
      return run(() => alertList(client));

    default:
      return err(`Unknown tool: ${name}`);
  }
});

async function main() {
  await client.connect();
  process.stderr.write('[truenas-mcp] Connected and authenticated to TrueNAS.\n');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(
    `[truenas-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
