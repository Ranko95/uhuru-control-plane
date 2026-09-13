import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import * as access from '../src/access/use-cases.ts';
import * as nodes from '../src/nodes/use-cases.ts';
import { getConfigurations } from '../src/delivery/use-cases.ts';

const db = new pg.Pool({ host: process.env.TEST_DATABASE_SOCKET, user: 'postgres', database: 'postgres' });
const pool = new pg.Pool({ host: process.env.TEST_DATABASE_SOCKET, user: 'uhuru', database: 'postgres' });
const authorization = `Basic ${Buffer.from('admin:integration-password').toString('base64')}`;
let app: ReturnType<typeof buildApp>;
let port: number;
let tls: { key: Buffer; cert: Buffer };
async function startApp() {
  app = buildApp({ pool, origin: 'https://localhost', adminUsername: 'admin', adminPassword: 'integration-password', tls });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as { port: number }).port;
}
async function request(method: string, path: string, payload?: unknown, auth: string | null = authorization) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string; json: () => any }>((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', servername: 'localhost', port, ca: tls.cert, method, path,
      headers: { ...(auth ? { authorization: auth } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}
async function dropResponse(path: string, payload?: unknown, auth = authorization) {
  await new Promise<void>((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', servername: 'localhost', port, ca: tls.cert, method: 'POST', path,
      headers: { authorization: auth, ...(payload ? { 'content-type': 'application/json' } : {}) } }, response => {
      response.destroy(); // Headers arrive after commit; discard the body and close the connection.
      resolve();
    });
    req.on('error', reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}
before(async () => {
  await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const grants = await readFile(new URL('../deploy/app-role.sql', import.meta.url), 'utf8');
  await db.query(grants.replaceAll('DATABASE uhuru', 'DATABASE postgres'));
  const root = process.env.TEST_DATABASE_SOCKET!;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', `${root}/key.pem`, '-out', `${root}/cert.pem`], { stdio: 'ignore' });
  tls = { key: await readFile(`${root}/key.pem`), cert: await readFile(`${root}/cert.pem`) };
  await startApp();
});
beforeEach(async () => { await db.query('TRUNCATE users, access_profiles, subscriptions, nodes, node_sync'); });
after(async () => { await app?.close(); await pool.end(); await db.end(); });

test('commercial use cases own issuance and their controllers retain validation and authentication', async () => {
  const node = await registerNode();
  const user = await access.createUser(pool, 'Direct use case');
  for (const [method, path] of [
    ['POST', '/admin/users'], ['GET', '/admin/users'], ['GET', '/admin/plan'],
    ['POST', `/admin/users/${user.id}/first-profile`], ['GET', `/admin/users/${user.id}/profiles`],
    ['POST', `/admin/profiles/${randomUUID()}/link`],
  ]) assert.equal((await request(method, path, undefined, null)).status, 401);
  assert.equal((await request('POST', '/admin/users', { label: '   ' })).status, 400);
  assert.equal((await request('POST', '/admin/users/not-a-uuid/first-profile')).status, 400);
  const first = await access.issueFirstProfile(pool, user.id, 'https://localhost');
  assert.deepEqual(await access.showProfileLink(pool, first.profile_id, 'https://localhost'), first);
  assert.deepEqual(await access.issueFirstProfile(pool, user.id, 'https://localhost'), first);
  assert.equal(first.ends_at.getTime() - first.starts_at.getTime(), 2_592_000_000);
  assert.equal((await access.listProfiles(pool, user.id)).length, 1);
  assert.equal((await sync(node)).json().desired.revision, '2');
  await assert.rejects(access.issueFirstProfile(pool, randomUUID(), 'https://localhost'),
    error => error instanceof access.AccessError && error.reason === 'not_found');
});

test('a subscription requires a first profile owned by the same user', async () => {
  const owner = randomUUID(), other = randomUUID(), profile = randomUUID();
  await db.query('INSERT INTO users(id,label) VALUES ($1,$3),($2,$3)', [owner, other, 'test user']);
  await db.query('INSERT INTO access_profiles(id,user_id,vless_uuid,link_secret) VALUES ($1,$2,$3,$4)',
    [profile, owner, randomUUID(), Buffer.alloc(32, 1)]);
  await assert.rejects(db.query(`INSERT INTO subscriptions(user_id,first_profile_id,starts_at,ends_at)
    VALUES ($1,$2,clock_timestamp(),clock_timestamp()+interval '720 hours')`, [other, profile]), { code: '23503' });
  await db.query(`INSERT INTO subscriptions(user_id,first_profile_id,starts_at,ends_at)
    VALUES ($1,$2,'2026-01-31 12:00:00Z','2026-03-02 12:00:00Z')`, [owner, profile]);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM subscriptions WHERE user_id=$1', [owner])).rows[0].count, 1);
});

test('HTTPS admin creates a user and safely repeats first issuance and link display', async () => {
  assert.equal((await request('POST', '/admin/users', { label: 'Alice' }, null)).status, 401);
  const user = (await request('POST', '/admin/users', { label: 'Alice' })).json();
  const issued = await request('POST', `/admin/users/${user.id}/first-profile`);
  assert.equal(issued.status, 200);
  assert.equal(issued.headers['cache-control'], 'no-store');
  const first = issued.json();
  assert.equal(first.status, 'active');
  assert.equal(new Date(first.ends_at).getTime() - new Date(first.starts_at).getTime(), 2_592_000_000);
  assert.equal(new URL(first.link).protocol, 'https:');
  const repeated = (await request('POST', `/admin/users/${user.id}/first-profile`)).json();
  assert.ok(JSON.stringify(repeated) === JSON.stringify(first), 'issuance must be idempotent');
  const shown = await request('POST', `/admin/profiles/${first.first_profile_id}/link`);
  assert.ok(shown.json().link === first.link);
  const list = (await request('GET', `/admin/users/${user.id}/profiles`)).json();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'revoked_at', 'status']);
});

const connection = { inbound_tag: 'vless', host: 'vpn.example.test', port: 443,
  server_name: 'example.test', public_key: Buffer.alloc(32, 4).toString('base64url'), short_id: 'abcd', fingerprint: 'chrome' };
async function registerNode() {
  const bearer = randomBytes(32).toString('base64url');
  const result = await request('POST', '/admin/nodes', { label: 'Test node', public_connection: connection, bearer });
  assert.equal(result.status, 201);
  return { id: result.json().id as string, bearer };
}
async function issue() {
  const user = (await request('POST', '/admin/users', { label: 'Subscriber' })).json();
  const result = await request('POST', `/admin/users/${user.id}/first-profile`);
  assert.equal(result.status, 200);
  return { user, ...result.json(), path: new URL(result.json().link).pathname };
}
async function sync(node: { id: string; bearer: string }, saved: unknown = null, verified: unknown = null, error: unknown = null) {
  return request('POST', '/agent/v1/sync', { node_id: node.id, saved, verified, error }, `Bearer ${node.bearer}`);
}
test('only a sent and verified snapshot unlocks the profile, with stable first confirmation', async () => {
  const node = await registerNode();
  const profile = await issue();
  assert.equal((await request('GET', profile.path, undefined, null)).status, 503);
  const pending = (await sync(node)).json();
  assert.equal(pending.status, 'snapshot');
  assert.equal(pending.snapshot.users.length, 1);
  assert.equal(pending.snapshot.users[0].profile_id, profile.first_profile_id);
  assert.equal(pending.desired.revision, '2');
  assert.equal((await sync(node, pending.desired)).json().ack_status, 'none');
  assert.equal((await request('GET', profile.path, undefined, null)).status, 503);
  const accepted = (await sync(node, pending.desired, pending.desired)).json();
  assert.deepEqual(Object.keys(accepted).sort(), ['ack_status', 'desired', 'poll_after_seconds', 'status']);
  assert.equal(accepted.ack_status, 'accepted');
  assert.equal(accepted.status, 'up_to_date');
  const ready = (await request('GET', `/admin/profiles/${profile.first_profile_id}/readiness`)).json();
  assert.equal(ready[0].ready, true);
  const config = await request('GET', profile.path, undefined, null);
  assert.equal(config.status, 200);
  assert.equal(config.headers['content-type'], 'text/plain; charset=utf-8');
  const uris = config.text.trim().split('\n');
  assert.equal(uris.length, 1);
  const uri = new URL(uris[0]);
  assert.ok(uri.username === pending.snapshot.users[0].vless_uuid);
  assert.equal(uri.searchParams.get('security'), 'reality');
  assert.equal(uri.searchParams.get('flow'), 'xtls-rprx-vision');
  assert.equal((await sync(node, pending.desired, pending.desired)).json().ack_status, 'already_confirmed');
  const repeated = (await request('GET', `/admin/profiles/${profile.first_profile_id}/readiness`)).json();
  assert.equal(repeated[0].confirmed_at, ready[0].confirmed_at);
  assert.ok(repeated[0].last_seen_at >= ready[0].last_seen_at);
  assert.equal(config.headers['cache-control'], 'no-store');
});

test('configuration delivery works without HTTP and preserves URI encoding and response headers', async () => {
  const label = 'Москва #1 / ?';
  const bearer = randomBytes(32);
  const node = await nodes.registerNode(pool, label, connection, bearer);
  const p = await issue();
  const linkSecret = Buffer.from(p.path.slice('/s/'.length), 'base64url');
  await assert.rejects(getConfigurations(pool, linkSecret), { message: 'no_ready_nodes' });
  const report = { node_id: node.id, saved: null, verified: null, error: null };
  const pending = await nodes.synchronize(pool, bearer, report);
  await nodes.synchronize(pool, bearer, { ...report, saved: pending.desired, verified: pending.desired });
  const body = await getConfigurations(pool, linkSecret);
  const response = await request('GET', p.path, undefined, null);
  assert.equal(response.status, 200);
  assert.ok(response.text === body, 'controller must return the use-case result unchanged');
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  const [line, trailing, extra] = body.split('\n');
  assert.equal(trailing, '');
  assert.equal(extra, undefined);
  const uri = new URL(line);
  assert.equal(uri.protocol, 'vless:');
  assert.equal(uri.hostname, connection.host);
  assert.equal(uri.port, String(connection.port));
  assert.ok(uri.username === pending.snapshot!.users[0].vless_uuid, 'URI must contain the confirmed credential');
  assert.equal(decodeURIComponent(uri.hash.slice(1)), label);
  assert.deepEqual(Object.fromEntries(uri.searchParams), { encryption: 'none', type: 'tcp', security: 'reality',
    flow: 'xtls-rprx-vision', sni: connection.server_name, pbk: connection.public_key, sid: connection.short_id, fp: connection.fingerprint });
  const escapedPath = '/s/%' + p.path.charCodeAt(3).toString(16) + p.path.slice(4);
  assert.equal((await request('GET', escapedPath, undefined, null)).status, 404);
});

test('parallel first issuance and server restart preserve one first profile and term', async () => {
  const node = await registerNode();
  const user = (await request('POST', '/admin/users', { label: 'Concurrent' })).json();
  const results = await Promise.all(Array.from({ length: 8 }, () => request('POST', `/admin/users/${user.id}/first-profile`)));
  assert.ok(results.every(r => r.status === 200 && r.text === results[0].text));
  // The retry key remains the known user, across restart.
  await app.close(); await startApp();
  const afterRestart = await request('POST', `/admin/users/${user.id}/first-profile`);
  assert.ok(afterRestart.text === results[0].text);
  assert.equal((await request('GET', `/admin/users/${user.id}/profiles`)).json().length, 1);
  assert.equal((await sync(node)).json().desired.revision, '2');
});

test('a lost first issuance response is recovered after restart with the same profile and link', async () => {
  const user = (await request('POST', '/admin/users', { label: 'Lost response' })).json();
  await dropResponse(`/admin/users/${user.id}/first-profile`);
  const profiles = (await request('GET', `/admin/users/${user.id}/profiles`)).json();
  assert.equal(profiles.length, 1);
  const shown = await request('POST', `/admin/profiles/${profiles[0].id}/link`);
  await app.close(); await startApp();
  const recovered = await request('POST', `/admin/users/${user.id}/first-profile`);
  assert.equal(recovered.status, 200);
  assert.ok(recovered.text === shown.text);
  assert.equal((await request('GET', `/admin/users/${user.id}/profiles`)).json().length, 1);
});

test('failure before commit rolls back the profile, subscription and all desired changes', async () => {
  const a = await registerNode(), b = await registerNode();
  const before = [(await sync(a)).json().desired, (await sync(b)).json().desired];
  const user = (await request('POST', '/admin/users', { label: 'Rollback' })).json();
  await db.query(`CREATE FUNCTION fail_issuance() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected failure'; END $$;
    CREATE CONSTRAINT TRIGGER fail_issuance AFTER INSERT ON subscriptions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_issuance()`);
  try { assert.equal((await request('POST', `/admin/users/${user.id}/first-profile`)).status, 503); }
  finally { await db.query('DROP TRIGGER fail_issuance ON subscriptions; DROP FUNCTION fail_issuance()'); }
  assert.equal((await request('GET', `/admin/users/${user.id}/profiles`)).json().length, 0);
  assert.equal((await request('GET', '/admin/users')).json().length, 1);
  assert.deepEqual([(await sync(a)).json().desired, (await sync(b)).json().desired], before);
  assert.equal((await request('POST', `/admin/users/${user.id}/first-profile`)).status, 200);
});

test('issuance takes PostgreSQL time after waiting for both user and node locks', async () => {
  const node = await registerNode();
  for (const table of ['users', 'nodes']) {
    const user = (await request('POST', '/admin/users', { label: 'Lock wait' })).json();
    const blocker = await db.connect();
    await blocker.query('BEGIN');
    try {
      await blocker.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [table === 'users' ? user.id : node.id]);
      const issuing = request('POST', `/admin/users/${user.id}/first-profile`);
      const deadline = Date.now() + 5000;
      while (!(await db.query("SELECT 1 FROM pg_stat_activity WHERE usename='uhuru' AND wait_event_type='Lock'")).rowCount) {
        assert.ok(Date.now() < deadline, 'HTTP issuance must reach the held lock');
        await new Promise(r => setTimeout(r, 10));
      }
      const releasedAt = (await blocker.query('SELECT clock_timestamp() AS t')).rows[0].t;
      await blocker.query('COMMIT');
      const result = await issuing;
      assert.equal(result.status, 200);
      assert.ok(new Date(result.json().starts_at).getTime() >= releasedAt.getTime());
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  }
});

test('database constraints and UTC hours preserve secrets, ownership and exact expiry boundaries', async () => {
  const p = await issue();
  const { rows: [raw] } = await db.query('SELECT * FROM access_profiles WHERE id=$1', [p.first_profile_id]);
  assert.ok(raw.id !== raw.vless_uuid && raw.link_secret.length === 32);
  for (const values of [[randomUUID(), raw.vless_uuid, randomBytes(32)], [randomUUID(), randomUUID(), raw.link_secret]]) {
    await assert.rejects(db.query('INSERT INTO access_profiles(id,user_id,vless_uuid,link_secret) VALUES ($1,$2,$3,$4)',
      [values[0], p.user.id, values[1], values[2]]), { code: '23505' });
  }
  await assert.rejects(db.query("UPDATE subscriptions SET ends_at='infinity' WHERE user_id=$1", [p.user.id]), { code: '23514' });
  await assert.rejects(db.query('UPDATE subscriptions SET ends_at=starts_at WHERE user_id=$1', [p.user.id]), { code: '23514' });
  await assert.rejects(pool.query('UPDATE access_profiles SET vless_uuid=$2 WHERE id=$1', [raw.id, randomUUID()]), { code: '42501' });
  await assert.rejects(pool.query('UPDATE subscriptions SET first_profile_id=$2 WHERE user_id=$1', [p.user.id, randomUUID()]), { code: '42501' });
  await assert.rejects(pool.query('DELETE FROM users'), { code: '42501' });
  assert.equal((await request('GET', '/admin/plan')).json().price_kopecks, null);
  for (const start of ['2026-01-31T12:00:00Z', '2026-03-01T12:00:00Z', '2026-10-25T12:00:00Z']) {
    await db.query("SET timezone='America/New_York'");
    await db.query("UPDATE subscriptions SET starts_at=$2,ends_at=$2::timestamptz+interval '720 hours' WHERE user_id=$1", [p.user.id, start]);
    const { rows: [row] } = await db.query(`SELECT extract(epoch FROM ends_at-starts_at)::int AS seconds,
      (SELECT count(*)::int FROM active_profiles(s.ends_at)) AS at_end,
      (SELECT count(*)::int FROM active_profiles(s.ends_at-interval '1 microsecond')) AS before_end
      FROM subscriptions s WHERE user_id=$1`, [p.user.id]);
    assert.deepEqual(row, { seconds: 2592000, at_end: 0, before_end: 1 });
  }
  await db.query("SET timezone='UTC'");
});

test('expired and revoked prepared profiles are never renewed or replaced by issuance or display', async () => {
  const p = await issue();
  await db.query("UPDATE subscriptions SET starts_at=clock_timestamp()-interval '721 hours', ends_at=clock_timestamp()-interval '1 hour' WHERE user_id=$1", [p.user.id]);
  const expired = (await request('POST', `/admin/users/${p.user.id}/first-profile`)).json();
  assert.equal(expired.status, 'expired');
  assert.ok(expired.link === p.link);
  assert.equal((await request('GET', p.path, undefined, null)).status, 403);
  await db.query('UPDATE access_profiles SET revoked_at=clock_timestamp() WHERE id=$1', [p.first_profile_id]);
  for (const path of [`/admin/users/${p.user.id}/first-profile`, `/admin/profiles/${p.first_profile_id}/link`]) {
    const result = (await request('POST', path)).json();
    assert.equal(result.status, 'revoked');
    assert.ok(!('link' in result));
    assert.equal(result.first_profile_id, p.first_profile_id);
  }
  assert.equal((await request('GET', p.path, undefined, null)).status, 410);
});

test('Node use cases roll back a failed ACK commit and keep readiness separate from inclusion and access', async () => {
  const bearer = randomBytes(32);
  const node = await nodes.registerNode(pool, 'Direct Node', connection, bearer);
  const p = await issue();
  const report = { node_id: node.id, saved: null, verified: null, error: null };
  const sent = await nodes.synchronize(pool, bearer, report);
  const ack = { ...report, saved: sent.desired, verified: sent.desired };
  const before = (await db.query('SELECT * FROM node_sync WHERE node_id=$1', [node.id])).rows[0];
  await db.query(`CREATE FUNCTION fail_ack() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected failure'; END $$;
    CREATE CONSTRAINT TRIGGER fail_ack AFTER UPDATE ON node_sync
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_ack()`);
  try { await assert.rejects(nodes.synchronize(pool, bearer, ack), { code: 'P0001' }); }
  finally { await db.query('DROP TRIGGER fail_ack ON node_sync; DROP FUNCTION fail_ack()'); }
  const after = (await db.query('SELECT * FROM node_sync WHERE node_id=$1', [node.id])).rows[0];
  assert.ok(JSON.stringify(after) === JSON.stringify(before), 'failed commit must preserve all sync state');
  assert.equal((await nodes.synchronize(pool, bearer, ack)).ack_status, 'accepted');
  const ready = (await nodes.getProfileReadiness(pool, p.first_profile_id))[0];
  assert.equal(ready.ready, true);
  const replacement = randomBytes(32);
  await nodes.rotateBearer(pool, node.id, replacement);
  await assert.rejects(nodes.synchronize(pool, bearer, ack),
    error => error instanceof nodes.NodeError && error.reason === 'unauthorized');
  assert.equal((await nodes.synchronize(pool, replacement, ack)).ack_status, 'already_confirmed');
  await db.query('UPDATE nodes SET include_in_subscription=false WHERE id=$1', [node.id]);
  assert.equal((await request('GET', p.path, undefined, null)).status, 503);
  await db.query("UPDATE subscriptions SET starts_at=clock_timestamp()-interval '721 hours', ends_at=clock_timestamp()-interval '1 hour' WHERE user_id=$1", [p.user.id]);
  const historical = (await nodes.getProfileReadiness(pool, p.first_profile_id))[0];
  assert.equal(historical.ready, true);
  assert.equal(historical.desired_access, false);
  assert.equal(historical.include_in_subscription, false);
  assert.deepEqual(historical.confirmed_at, ready.confirmed_at);
  assert.equal((await request('GET', p.path, undefined, null)).status, 403);
});

test('node Bearer binds one node and rotates without overlap or resetting access', async () => {
  const node = await registerNode(), other = await registerNode();
  for (const [method, path] of [
    ['POST', '/admin/nodes'], ['GET', '/admin/nodes'],
    ['PUT', `/admin/nodes/${node.id}/bearer`], ['GET', `/admin/profiles/${randomUUID()}/readiness`],
  ]) assert.equal((await request(method, path, undefined, null)).status, 401);
  assert.equal((await request('PUT', `/admin/nodes/${node.id}/bearer`, { bearer: node.bearer + '=' })).status, 400);
  assert.equal((await request('PUT', `/admin/nodes/${randomUUID()}/bearer`, { bearer: randomBytes(32).toString('base64url') })).status, 404);
  const p = await issue();
  const initial = (await sync(node)).json();
  assert.equal((await sync({ ...node, id: other.id })).status, 403);
  const invalid = await sync({ ...node, bearer: Buffer.alloc(32, 99).toString('base64url') });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers['www-authenticate'], 'Bearer');
  const replacement = randomBytes(32).toString('base64url');
  assert.equal((await request('PUT', `/admin/nodes/${node.id}/bearer`, { bearer: replacement })).status, 204);
  assert.equal((await sync(node)).status, 401);
  const updated = (await sync({ ...node, bearer: replacement })).json();
  assert.ok(JSON.stringify(updated) === JSON.stringify(initial));
  const hash = (await db.query('SELECT agent_secret_hash FROM nodes WHERE id=$1', [node.id])).rows[0].agent_secret_hash;
  assert.equal((await sync({ ...node, bearer: hash.toString('base64url') })).status, 401);
  assert.equal((await request('POST', `/admin/profiles/${p.first_profile_id}/link`, undefined, null)).status, 401);
  const nodes = (await request('GET', '/admin/nodes')).text;
  assert.ok(!nodes.includes(replacement) && !nodes.includes(initial.snapshot.users[0].vless_uuid));
});

test('canonical inputs and duplicate keys are rejected without revealing secrets', async () => {
  const node = await registerNode();
  const p = await issue();
  for (const suffix of ['=', '?x=1', '/']) {
    assert.equal((await request('GET', p.path + suffix, undefined, null)).status, 404);
  }
  const token = p.path.split('/').at(-1)!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1)!) + 1];
  assert.equal((await request('GET', `/s/${alias}`, undefined, null)).status, 404);
  assert.equal((await request('GET', `/s/${randomBytes(32).toString('base64url')}`, undefined, null)).status, 404);
  const body = `{"node_id":"${node.id}","saved":null,"verified":null,"error":null,"saved":null}`;
  assert.equal((await request('POST', '/agent/v1/sync', body, `Bearer ${node.bearer}`)).status, 400);
  const escaped = `{"node_id":"${node.id}","saved":null,"verified":null,"error":{"target":null,"stage":"apply","code":"failed","co\\u0064e":"failed"}}`;
  assert.equal((await request('POST', '/agent/v1/sync', escaped, `Bearer ${node.bearer}`)).status, 400);
  assert.equal((await sync(node, { revision: '9223372036854775808', snapshot_hash: '0'.repeat(64) })).status, 400);
  assert.equal((await request('POST', '/admin/nodes', { label: 'Bad', bearer: node.bearer, public_connection: { ...connection, private_key: 'must never be stored' } })).status, 400);
});

test('ACK provenance, all statuses and late diagnostics preserve monotone confirmation', async () => {
  const node = await registerNode();
  const stored = (await db.query('SELECT desired_snapshot FROM node_sync WHERE node_id=$1', [node.id])).rows[0].desired_snapshot;
  const initial = { revision: stored.revision, snapshot_hash: stored.snapshot_hash };
  assert.equal((await sync(node, initial, initial)).status, 409, 'current desired was not sent yet');
  const first = (await sync(node)).json();
  const p = await issue();
  const acceptedOld = (await sync(node, first.desired, first.desired)).json();
  assert.equal(acceptedOld.ack_status, 'accepted');
  assert.equal(acceptedOld.status, 'snapshot');
  assert.equal(acceptedOld.desired.revision, '2');
  await issue();
  const latest = (await sync(node)).json();
  assert.equal(latest.desired.revision, '3');
  const forgotten = (await sync(node, acceptedOld.desired, acceptedOld.desired)).json();
  assert.equal(forgotten.ack_status, 'unrecognized');
  assert.equal(forgotten.status, 'snapshot');
  assert.equal((await request('GET', p.path, undefined, null)).status, 503);
  await dropResponse('/agent/v1/sync', { node_id: node.id, saved: latest.desired, verified: latest.desired, error: null }, `Bearer ${node.bearer}`);
  const accepted = (await sync(node, latest.desired, latest.desired)).json();
  assert.equal(accepted.ack_status, 'already_confirmed');
  const before = (await request('GET', `/admin/profiles/${p.first_profile_id}/readiness`)).json()[0];
  assert.equal((await sync(node, acceptedOld.desired, acceptedOld.desired)).json().ack_status, 'ignored_stale');
  const diagnostic = { stage: 'apply', code: 'mutation_outcome_unknown', target: { revision: '99', snapshot_hash: 'f'.repeat(64) } };
  assert.equal((await sync(node, null, null, diagnostic)).json().ack_status, 'none');
  const after = (await request('GET', `/admin/profiles/${p.first_profile_id}/readiness`)).json()[0];
  assert.equal(after.ready, true);
  assert.equal(after.confirmed_at, before.confirmed_at);
  assert.deepEqual(after.confirmed, before.confirmed);
  assert.deepEqual(after.last_received_report.error, diagnostic);
  assert.equal((await sync(node, latest.desired, latest.desired)).json().ack_status, 'already_confirmed');
  assert.equal((await sync(node, { ...latest.desired, snapshot_hash: '0'.repeat(64) })).status, 409);
  assert.equal((await sync(node, { ...latest.desired, revision: '4' })).status, 409);
  assert.equal((await sync(node, null, latest.desired)).status, 400);
  // Altering another profile does not hide a previously confirmed profile.
  await issue();
  assert.equal((await request('GET', p.path, undefined, null)).status, 200);
  await db.query('UPDATE node_sync SET desired_snapshot=$2 WHERE node_id=$1', [node.id, stored]);
  assert.equal((await sync(node)).status, 409, 'restored counters must not be reset automatically');
});

test('the real-agent JCS golden snapshot verifies sorted users and fails closed on database corruption', async () => {
  const node = { id: '10000000-0000-4000-8000-000000000001', bearer: randomBytes(32).toString('base64url') };
  const { createHash } = await import('node:crypto');
  const value = { node_id: node.id, revision: '1', inbound_tag: 'vless', users: [
    { profile_id: '20000000-0000-4000-8000-000000000002', vless_uuid: '30000000-0000-4000-8000-000000000002' },
    { profile_id: '20000000-0000-4000-8000-000000000001', vless_uuid: '30000000-0000-4000-8000-000000000001' },
  ] };
  const golden = { revision: '1', snapshot_hash: '2c43039fec48a7b3144418850292f9ac9c15056f3ce76fa66e4c9ceb6164a986', snapshot: value };
  await db.query('INSERT INTO nodes(id,label,public_connection,agent_secret_hash) VALUES ($1,$2,$3,$4)',
    [node.id, 'Golden', connection, createHash('sha256').update(Buffer.from(node.bearer, 'base64url')).digest()]);
  await db.query('INSERT INTO node_sync(node_id,desired_snapshot) VALUES ($1,$2)', [node.id, golden]);
  const response = await sync(node);
  assert.equal(response.status, 200);
  assert.equal(response.json().desired.snapshot_hash, golden.snapshot_hash);
  assert.equal(response.json().snapshot.users[0].profile_id, value.users[1].profile_id);
  await db.query('UPDATE node_sync SET desired_snapshot=$2 WHERE node_id=$1', [node.id, { ...golden, snapshot_hash: '0'.repeat(64) }]);
  assert.equal((await sync(node)).status, 503);
});

test('prepared profile limits include every unrevoked profile and readiness requires the exact credential', async () => {
  const user = (await request('POST', '/admin/users', { label: 'Prepared limit' })).json();
  for (let i = 0; i < 3; i++) {
    await db.query('INSERT INTO access_profiles(id,user_id,vless_uuid,link_secret) VALUES ($1,$2,$3,$4)',
      [randomUUID(), user.id, randomUUID(), randomBytes(32)]);
  }
  assert.equal((await request('POST', `/admin/users/${user.id}/first-profile`)).status, 409);
  const node = await registerNode();
  const p = await issue();
  const sent = (await sync(node)).json();
  await sync(node, sent.desired, sent.desired);
  assert.equal((await request('GET', p.path, undefined, null)).status, 200);
  // DBA-only corruption fixture: an old confirmation cannot authorize a different UUID.
  await db.query('UPDATE access_profiles SET vless_uuid=$2 WHERE id=$1', [p.first_profile_id, randomUUID()]);
  assert.equal((await request('GET', p.path, undefined, null)).status, 503);
  assert.equal((await request('GET', `/admin/profiles/${p.first_profile_id}/readiness`)).json()[0].ready, false);
});
