import Fastify from 'fastify';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { checked, snapshot, uuidPattern, state } from './snapshot.ts';
import { synchronize, reportSchema } from './sync.ts';
import type { Report } from './sync.ts';
import { digest, HttpError, object, parseJson, secret } from './protocol.ts';
export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL timezone = 'UTC'");
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
const idSchema = { type: 'string', pattern: uuidPattern };
const idParams = object({ id: idSchema });
const connectionSchema = object({
  inbound_tag: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' },
  host: { type: 'string', maxLength: 253, pattern: '^[a-zA-Z0-9.-]+$' },
  port: { type: 'integer', minimum: 1, maximum: 65535 },
  server_name: { type: 'string', maxLength: 253, pattern: '^[a-zA-Z0-9.-]+$' },
  public_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  short_id: { type: 'string', pattern: '^(?:[0-9a-f]{2}){1,8}$' },
  fingerprint: { enum: ['chrome'] },
});
type Connection = { inbound_tag: string; host: string; port: number; server_name: string;
  public_key: string; short_id: string; fingerprint: string };

async function readiness(db: Pool | PoolClient, profileId: string) {
  const { rows: [profile] } = await db.query(`SELECT p.id,p.vless_uuid,p.revoked_at IS NULL AND clock_timestamp()<s.ends_at AS active
    FROM access_profiles p JOIN subscriptions s ON s.user_id=p.user_id WHERE p.id=$1`, [profileId]);
  if (!profile) throw new HttpError(404);
  const nodes = await db.query(`SELECT n.id,n.label,n.public_connection,n.include_in_subscription,s.*
    FROM nodes n JOIN node_sync s ON s.node_id=n.id ORDER BY n.id`);
  return nodes.rows.map(n => {
    const confirmed = n.confirmed_snapshot && checked(n.confirmed_snapshot, n.id, n.public_connection.inbound_tag);
    return { id: n.id, label: n.label, include_in_subscription: n.include_in_subscription,
      ready: !!confirmed?.snapshot.users.some((p: { profile_id: string; vless_uuid: string }) => p.profile_id === profile.id && p.vless_uuid === profile.vless_uuid),
      desired_access: profile.active, confirmed: confirmed ? state(confirmed) : null,
      confirmed_at: n.confirmed_at, last_seen_at: n.last_seen_at, last_received_report: n.last_received_report };
  });
}

async function showLink(db: PoolClient, profileId: string, origin: string) {
  const { rows: [p] } = await db.query(`SELECT p.id AS profile_id, p.link_secret, s.first_profile_id, s.starts_at, s.ends_at,
    CASE WHEN p.revoked_at IS NOT NULL THEN 'revoked'
      WHEN clock_timestamp() >= s.ends_at THEN 'expired' ELSE 'active' END AS status
    FROM access_profiles p JOIN subscriptions s ON s.user_id = p.user_id WHERE p.id = $1`, [profileId]);
  if (!p) throw new HttpError(404);
  const { link_secret, ...visible } = p;
  return { ...visible, ...(p.status === 'revoked' ? {} : { link: `${origin}/s/${link_secret.toString('base64url')}` }) };
}

export function buildApp(options: {
  pool: Pool; origin: string; adminUsername: string; adminPassword: string;
  tls: { key: Buffer; cert: Buffer };
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !options.adminUsername || options.adminUsername.includes(':') || options.adminPassword.length < 16) {
    throw new Error('invalid_settings');
  }
  const { pool } = options;
  const adminHash = digest(`Basic ${Buffer.from(`${options.adminUsername}:${options.adminPassword}`).toString('base64')}`);
  const app = Fastify({ https: options.tls, logger: false, bodyLimit: 2 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, parseJson(body as string)); } catch { done(new HttpError(400)); }
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (!(req.raw.socket as import('node:tls').TLSSocket).encrypted) throw new HttpError(400);
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as { statusCode?: number; code?: string };
    const status = e.code === '23505' ? 409 : e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 503;
    if (status === 503) reply.header('Retry-After', '15');
    if (status === 401 && !reply.hasHeader('WWW-Authenticate')) reply.header('WWW-Authenticate', 'Bearer');
    reply.code(status).send({ error: status === 503 ? 'temporarily_unavailable' : 'request_rejected' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.register(async admin => {
    admin.addHook('onRequest', async (req, reply) => {
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), adminHash)) {
        reply.header('WWW-Authenticate', 'Basic realm="Uhuru", charset="UTF-8"');
        throw new HttpError(401);
      }
    });
    admin.post<{ Body: { label: string } }>('/users', { schema: { body: object({ label: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } }) } }, async (req, reply) => {
      const user = { id: randomUUID(), label: req.body.label.trim() };
      await pool.query('INSERT INTO users(id,label) VALUES ($1,$2)', [user.id, user.label]);
      return reply.code(201).send(user);
    });
    admin.get('/users', async () => (await pool.query('SELECT id,label FROM users ORDER BY id')).rows);
    admin.get('/plan', async () => (await pool.query('SELECT * FROM service_settings WHERE id=1')).rows[0]);
    admin.post<{ Body: { label: string; public_connection: Connection; bearer: string } }>('/nodes', {
      schema: { body: object({ label: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        public_connection: connectionSchema, bearer: { type: 'string' } }) },
    }, async (req, reply) => {
      const raw = secret(req.body.bearer);
      if (!raw || !secret(req.body.public_connection.public_key)) throw new HttpError(400);
      const node = await transaction(pool, async db => {
        await db.query('SELECT id FROM service_settings WHERE id=1 FOR UPDATE');
        const id = randomUUID();
        const profiles = (await db.query('SELECT * FROM active_profiles(clock_timestamp())')).rows;
        await db.query('INSERT INTO nodes(id,label,public_connection,agent_secret_hash) VALUES ($1,$2,$3,$4)',
          [id, req.body.label.trim(), req.body.public_connection, digest(raw)]);
        await db.query('INSERT INTO node_sync(node_id,desired_snapshot) VALUES ($1,$2)',
          [id, snapshot(id, req.body.public_connection.inbound_tag, '1', profiles)]);
        return { id, label: req.body.label.trim() };
      });
      return reply.code(201).send(node);
    });
    admin.put<{ Params: { id: string }; Body: { bearer: string } }>('/nodes/:id/bearer', {
      schema: { params: idParams, body: object({ bearer: { type: 'string' } }) },
    }, async (req, reply) => {
      const raw = secret(req.body.bearer);
      if (!raw) throw new HttpError(400);
      const result = await pool.query('UPDATE nodes SET agent_secret_hash=$2 WHERE id=$1', [req.params.id, digest(raw)]);
      if (!result.rowCount) throw new HttpError(404);
      return reply.code(204).send();
    });
    admin.get('/nodes', async () => (await pool.query(`SELECT n.id,n.label,n.public_connection,n.include_in_subscription,
      s.confirmed_at,s.last_seen_at,s.last_received_report,
      s.desired_snapshot->>'revision' AS desired_revision,s.confirmed_snapshot->>'revision' AS confirmed_revision
      FROM nodes n JOIN node_sync s ON s.node_id=n.id ORDER BY n.id`)).rows);
    admin.post<{ Params: { id: string } }>('/users/:id/first-profile', { schema: { params: idParams } }, async req => transaction(pool, async db => {
      const user = await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!user.rowCount) throw new HttpError(404);
      const { rows: [existing] } = await db.query('SELECT first_profile_id FROM subscriptions WHERE user_id=$1', [req.params.id]);
      if (existing) return showLink(db, existing.first_profile_id, origin.origin);
      // ponytail: one topology/issuance lock; separate enrollment serialization if pilot throughput demands it.
      await db.query('SELECT id FROM service_settings WHERE id=1 FOR UPDATE');
      const nodes = await db.query(`SELECT n.id,n.public_connection,s.desired_snapshot FROM nodes n
        JOIN node_sync s ON s.node_id=n.id ORDER BY n.id FOR UPDATE OF n,s`);
      const { rows: [{ t }] } = await db.query('SELECT clock_timestamp()::text AS t');
      const { rows: [{ count }] } = await db.query('SELECT count(*)::int AS count FROM access_profiles WHERE user_id=$1 AND revoked_at IS NULL', [req.params.id]);
      if (count >= 3) throw new HttpError(409);
      const id = randomUUID();
      await db.query('INSERT INTO access_profiles(id,user_id,vless_uuid,link_secret) VALUES ($1,$2,$3,$4)',
        [id, req.params.id, randomUUID(), randomBytes(32)]);
      await db.query(`INSERT INTO subscriptions(user_id,first_profile_id,starts_at,ends_at)
        VALUES ($1,$2,$3::timestamptz,$3::timestamptz+interval '720 hours')`, [req.params.id, id, t]);
      const profiles = (await db.query('SELECT * FROM active_profiles($1)', [t])).rows;
      for (const node of nodes.rows) {
        const old = checked(node.desired_snapshot, node.id, node.public_connection.inbound_tag);
        if (JSON.stringify(old.snapshot.users) !== JSON.stringify(profiles)) {
          const next = snapshot(node.id, old.snapshot.inbound_tag, String(BigInt(old.revision) + 1n), profiles);
          await db.query('UPDATE node_sync SET desired_snapshot=$2 WHERE node_id=$1', [node.id, next]);
        }
      }
      return showLink(db, id, origin.origin);
    }));
    admin.post<{ Params: { id: string } }>('/profiles/:id/link', { schema: { params: idParams } }, async req =>
      transaction(pool, db => showLink(db, req.params.id, origin.origin)));
    admin.get<{ Params: { id: string } }>('/users/:id/profiles', { schema: { params: idParams } }, async req =>
      (await pool.query(`SELECT p.id,p.revoked_at,CASE WHEN p.revoked_at IS NOT NULL THEN 'revoked'
        WHEN s.user_id IS NULL OR clock_timestamp() >= s.ends_at THEN 'expired' ELSE 'active' END AS status
        FROM access_profiles p LEFT JOIN subscriptions s ON s.user_id=p.user_id WHERE p.user_id=$1 ORDER BY p.id`, [req.params.id])).rows);
    admin.get<{ Params: { id: string } }>('/profiles/:id/readiness', { schema: { params: idParams } }, async req => readiness(pool, req.params.id));
  }, { prefix: '/admin' });

  app.post<{ Body: Report }>('/agent/v1/sync', { schema: { body: reportSchema } }, async req =>
    transaction(pool, db => synchronize(db, req.headers.authorization ?? '', req.body)));
  app.get<{ Params: { secret: string } }>('/s/:secret', async (req, reply) => {
    // Check the wire encoding, including URL escaping, before a database lookup.
    if (req.raw.url !== `/s/${req.params.secret}`) throw new HttpError(404);
    const raw = secret(req.params.secret);
    if (!raw) throw new HttpError(404);
    const result = await transaction(pool, async db => {
      const { rows: [profile] } = await db.query(`SELECT p.id,p.vless_uuid,p.revoked_at,
        clock_timestamp()<s.ends_at AS active FROM access_profiles p
        JOIN subscriptions s ON s.user_id=p.user_id WHERE p.link_secret=$1`, [raw]);
      if (!profile) throw new HttpError(404);
      if (profile.revoked_at) throw new HttpError(410);
      if (!profile.active) throw new HttpError(403);
      const nodes = (await db.query(`SELECT n.id,n.label,n.public_connection,s.confirmed_snapshot
        FROM nodes n JOIN node_sync s ON s.node_id=n.id WHERE n.include_in_subscription ORDER BY n.id`)).rows;
      const configs = [];
      for (const n of nodes) {
        if (!n.confirmed_snapshot) continue;
        const confirmed = checked(n.confirmed_snapshot, n.id, n.public_connection.inbound_tag);
        if (!confirmed.snapshot.users.some(p => p.profile_id === profile.id && p.vless_uuid === profile.vless_uuid)) continue;
        const c = n.public_connection as Connection;
        const query = new URLSearchParams({ encryption: 'none', type: 'tcp', security: 'reality',
          flow: 'xtls-rprx-vision', sni: c.server_name, pbk: c.public_key, sid: c.short_id, fp: c.fingerprint });
        configs.push(`vless://${profile.vless_uuid}@${c.host}:${c.port}?${query}#${encodeURIComponent(n.label)}`);
      }
      if (!configs.length) throw new HttpError(503);
      return `${configs.join('\n')}\n`;
    });
    return reply.type('text/plain; charset=utf-8').send(result);
  });
  return app;
}
