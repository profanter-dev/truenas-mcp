import { TrueNASClient } from '../truenas-client.js';

type AnyObj = Record<string, unknown>;

// Strip key material from config objects — catches PEM blocks, OpenSSH public keys,
// and TrueNAS host_*_key / host_*_key_pub / host_*_key_cert_pub fields.
function sanitizeConfig(config: AnyObj): AnyObj {
  const KEY_NAME = /^(host_.+_key(_pub|_cert_pub)?|.*(private|secret)_key.*)$/i;
  const PEM_VALUE = /^-----BEGIN /;
  const OPENSSH_PUBKEY = /^(ssh-|ecdsa-sha2-|sk-)/;

  return Object.fromEntries(
    Object.entries(config).filter(([k, v]) => {
      if (KEY_NAME.test(k)) return false;
      if (typeof v === 'string' && (PEM_VALUE.test(v) || OPENSSH_PUBKEY.test(v))) return false;
      return true;
    }),
  );
}

// Maps TrueNAS service names to their config API methods.
const CONFIG_METHOD: Record<string, string> = {
  cifs:        'smb.config',
  nfs:         'nfs.config',
  ssh:         'ssh.config',
  ftp:         'ftp.config',
  tftp:        'tftp.config',
  snmp:        'snmp.config',
  ups:         'ups.config',
  lldp:        'lldp.config',
  rsync:       'rsyncd.config',
  webdav:      'webdav.config',
  iscsitarget: 'iscsi.global.config',
  smartd:      'smart.config',
  s3:          's3.config',
};

export async function serviceList(client: TrueNASClient): Promise<string> {
  const services = await client.call<AnyObj[]>('service.query', [[], { order_by: ['service'] }]);

  const result = services.map((s) => ({
    service: s['service'],
    state: s['state'],
    enabled: s['enable'],
  }));

  return JSON.stringify(result, null, 2);
}

export async function serviceDetails(client: TrueNASClient, serviceName: string): Promise<string> {
  const services = await client.call<AnyObj[]>('service.query', [[['service', '=', serviceName]]]);

  if (!services.length) {
    return JSON.stringify({ error: `Service '${serviceName}' not found.` }, null, 2);
  }

  const svc = services[0];
  const configMethod = CONFIG_METHOD[serviceName];

  let config: AnyObj | null = null;
  if (configMethod) {
    const raw = await client.call<AnyObj>(configMethod).catch(() => null);
    config = raw ? sanitizeConfig(raw) : null;
  }

  return JSON.stringify({
    service: svc['service'],
    state: svc['state'],
    enabled: svc['enable'],
    pids: svc['pids'],
    ...(config ? { config } : {}),
  }, null, 2);
}
