import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';

const db = new pg.Pool({
    host: process.env.PGHOST,
    user: 'postgres',
    database: 'postgres',
});
const password = randomBytes(32).toString('hex') + ':@/?#%';
const database = {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: 'server_login',
    password,
    database: 'postgres',
    maxPoolSize: 2,
};
const settings = {
    origin: 'https://localhost',
    port: 0,
    database,
    admin_username: 'admin',
    admin_password: 'integration-password',
};
let directory: string;
let path: string;

before(async () => {
    assert.equal(process.env.PGHOST, '127.0.0.1');
    assert.ok(process.env.PGPORT);
    await db.query(`CREATE ROLE server_login LOGIN PASSWORD ${pg.escapeLiteral(password)}`);
    await db.query('GRANT CONNECT ON DATABASE postgres TO server_login');
    directory = await mkdtemp(join(tmpdir(), 'uhuru-server-test-'));
    path = join(directory, 'settings.json');
});

after(async () => {
    await db.query('REVOKE CONNECT ON DATABASE postgres FROM server_login');
    await db.query('DROP ROLE server_login');
    await db.end();
    await rm(directory, { recursive: true, force: true });
});

test('server starts with database login fields and stops cleanly', { timeout: 10000 }, async () => {
    await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
    const server = spawn(process.execPath, ['src/server.ts', path], { timeout: 5000 });
    const exited = once(server, 'exit');
    let stderr = '';
    server.stderr.on('data', (chunk) => {
        stderr += chunk;
    });

    try {
        const output = await Promise.race([
            once(server.stdout, 'data').then(([chunk]) => chunk.toString()),
            exited.then(([code]) => {
                throw new Error(`server exited before startup: ${code}, ${stderr}`);
            }),
        ]);
        assert.equal(output, 'control_plane_started\n');
        server.kill('SIGTERM');
        assert.deepEqual(await exited, [0, null]);
        assert.equal(stderr, '');
    } finally {
        server.kill('SIGKILL');
        await exited;
    }
});

for (const [name, overrides] of [
    ['wrong password', { password: 'wrong-password' }],
    ['missing password', { password: undefined }],
    ['empty password', { password: '' }],
    ['missing host', { host: undefined }],
    ['Unix socket host', { host: '/var/run/postgresql' }],
    ['missing user', { user: undefined }],
    ['missing database', { database: undefined }],
    ['missing port', { port: undefined }],
    ['string port', { port: String(database.port) }],
    ['out-of-range port', { port: 65536 }],
    ['missing pool size', { maxPoolSize: undefined }],
    ['zero pool size', { maxPoolSize: 0 }],
    ['negative pool size', { maxPoolSize: -1 }],
    ['fractional pool size', { maxPoolSize: 1.5 }],
    ['string pool size', { maxPoolSize: '10' }],
    ['privileged role', { user: 'postgres', password: process.env.PGPASSWORD }],
] as const) {
    test(`server rejects ${name} without logging secrets`, async () => {
        await writeFile(path, JSON.stringify({ ...settings, database: { ...database, ...overrides } }));
        const result = spawnSync(process.execPath, ['src/server.ts', path], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'control_plane_failed\n');
    });
}
