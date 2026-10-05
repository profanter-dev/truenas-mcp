export interface Config {
  truenasHost: string;
  truenasApiKey: string;
  truenasInsecure: boolean;
  authToken: string;
  port: number;
  dockerSocket: string;
  dockerWriteTools: boolean;
  hostProc: string;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['TRUENAS_HOST', 'TRUENAS_API_KEY', 'MCP_AUTH_TOKEN'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const port = Number(env['PORT'] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env['PORT']}`);
  }

  return {
    truenasHost: env['TRUENAS_HOST']!,
    truenasApiKey: env['TRUENAS_API_KEY']!,
    truenasInsecure: env['TRUENAS_INSECURE'] === 'true',
    authToken: env['MCP_AUTH_TOKEN']!,
    port,
    dockerSocket: env['DOCKER_SOCKET'] || '/var/run/docker.sock',
    dockerWriteTools: env['DOCKER_WRITE_TOOLS'] === 'true',
    hostProc: env['HOST_PROC'] || '/host/proc',
    version: env['APP_VERSION'] || 'dev',
  };
}
