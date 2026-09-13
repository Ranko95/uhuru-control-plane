import { readFile, stat } from 'node:fs/promises';
import pg from 'pg';
import { buildApp } from './app.ts';

process.umask(0o077);
function fatal() { process.stderr.write('control_plane_failed\n'); process.exit(1); }
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

try {
  if (process.platform !== 'linux') throw new Error('linux_required');
  const limits = await readFile('/proc/self/limits', 'utf8');
  if (!/^Max core file size\s+0\s+0\s+/m.test(limits)
    || (await readFile('/proc/sys/kernel/core_pattern', 'utf8')).trim().startsWith('|')) throw new Error('core_dump_policy');
  const path = process.argv[2];
  if (!path || ((await stat(path)).mode & 0o037) !== 0) throw new Error('private_settings_required');
  const settings = JSON.parse(await readFile(path, 'utf8'));
  if (typeof settings.database_socket !== 'string' || !settings.database_socket.startsWith('/')) throw new Error('unix_database_required');
  const pool = new pg.Pool({ host: settings.database_socket, user: 'uhuru', database: 'uhuru', max: 10 });
  pool.on('error', () => process.stderr.write('database_unavailable\n'));
  const { rows: [role] } = await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user');
  if (!role || Object.values(role).some(Boolean)) throw new Error('restricted_role_required');
  const app = buildApp({ pool, origin: settings.origin, adminUsername: settings.admin_username,
    adminPassword: settings.admin_password, tls: { key: await readFile(settings.tls_key), cert: await readFile(settings.tls_cert) } });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    void app.close().then(() => pool.end()).then(() => process.exit(0));
  });
  await app.listen({ host: settings.listen_host ?? '127.0.0.1', port: settings.port ?? 8443 });
  process.stdout.write('control_plane_started\n');
} catch { fatal(); }
