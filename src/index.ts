import 'dotenv/config';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { loadConfig, Config } from './config.js';
import { TrueNASClient } from './truenas-client.js';
import { makeDockerClient } from './docker-client.js';
import { createMcpServer } from './server.js';
import { ToolDef } from './tools/registry.js';
import { storageTools } from './tools/storage.js';
import { jobTools } from './tools/jobs.js';
import { alertTools } from './tools/alerts.js';
import { shareTools } from './tools/shares.js';
import { systemTools } from './tools/system.js';
import { appTools } from './tools/apps.js';
import { serviceTools } from './tools/services.js';
import { snapshotTools } from './tools/snapshots.js';
import { containerTools } from './tools/containers.js';
import { updateTools } from './tools/updates.js';

const MAX_BODY_BYTES = 1024 * 1024;

function log(msg: string) {
  process.stderr.write(`[truenas-mcp] ${msg}\n`);
}

let config: Config;
try {
  config = loadConfig();
} catch (e) {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const client = new TrueNASClient(config.truenasHost, config.truenasApiKey, config.truenasInsecure);
const docker = makeDockerClient(config.dockerSocket);

const tools: ToolDef[] = [
  ...systemTools(client),
  ...alertTools(client),
  ...storageTools(client),
  ...snapshotTools(client),
  ...shareTools(client),
  ...serviceTools(client),
  ...appTools(client),
  ...jobTools(client),
  ...(docker ? containerTools(docker, { write: config.dockerWriteTools }) : []),
  ...(docker ? updateTools(docker, { write: config.dockerWriteTools }) : []),
];

// Hash both sides so timingSafeEqual gets equal-length inputs and the token
// length doesn't leak through timing either.
const tokenDigest = createHash('sha256').update(config.authToken).digest();
function authorized(req: IncomingMessage): boolean {
  const header = req.headers['authorization'] ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(createHash('sha256').update(match[1]).digest(), tokenDigest);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  if (!authorized(req)) {
    return jsonRpcError(res, 401, -32001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
  }

  // Stateless mode: no sessions, so there is no SSE stream to GET or session to DELETE.
  if (req.method !== 'POST') {
    return jsonRpcError(res, 405, -32000, 'Method not allowed', { Allow: 'POST' });
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    const tooLarge = e instanceof Error && e.message === 'Request body too large';
    return jsonRpcError(res, tooLarge ? 413 : 400, -32700, tooLarge ? 'Request body too large' : 'Parse error');
  }

  // A fresh server + transport per request; the TrueNAS and Docker clients are shared.
  const server = createMcpServer(tools, config.version);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleHealth(res: ServerResponse) {
  const truenas = client.isConnected;
  const dockerOk = docker ? await docker.ping() : null;
  sendJson(res, truenas ? 200 : 503, { truenas, docker: dockerOk, version: config.version });
}

const httpServer = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  const handler = path === '/mcp' ? handleMcp(req, res)
    : path === '/healthz' && req.method === 'GET' ? handleHealth(res)
    : Promise.resolve(sendJson(res, 404, { error: 'Not found' }));

  handler.catch((e) => {
    log(`Request error: ${e instanceof Error ? e.message : String(e)}`);
    if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal error');
    else res.end();
  });
});

async function main() {
  await client.connect();
  log('Connected and authenticated to TrueNAS.');

  if (docker) {
    log(`Docker tools enabled via ${config.dockerSocket}${config.dockerWriteTools ? ' (write tools ON)' : ''}.`);
  } else {
    log(`Docker socket ${config.dockerSocket} not found — container tools disabled.`);
  }

  httpServer.listen(config.port, () => {
    log(`v${config.version} listening on :${config.port} (${tools.length} tools).`);
  });

  const shutdown = () => {
    log('Shutting down.');
    client.disconnect();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
