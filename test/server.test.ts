import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
let env: NodeJS.ProcessEnv;

before(async () => {
    assert.equal(process.env.PGHOST, '127.0.0.1');
    assert.ok(process.env.PGPORT);
    await db.query(`CREATE ROLE server_login LOGIN PASSWORD ${pg.escapeLiteral(password)}`);
    await db.query('GRANT CONNECT ON DATABASE postgres TO server_login');
    directory = await mkdtemp(join(tmpdir(), 'uhuru-server-test-'));
    path = join(directory, 'local.json');
    const defaults = join(directory, 'defaults');
    await mkdir(defaults);
    await copyFile('config/default.json', join(defaults, 'default.json'));
    env = {
        ...process.env,
        NODE_CONFIG_DIR: `${defaults}:${directory}`,
        NODE_ENV: 'production',
        NODE_CONFIG_ENV: 'production',
        NODE_CONFIG: '',
        NODE_APP_INSTANCE: '',
    };
    await writeFile(
        join(directory, 'production.json'),
        JSON.stringify({ origin: settings.origin, database: { port: database.port } }),
        { mode: 0o644 },
    );
});

after(async () => {
    await db.query('REVOKE CONNECT ON DATABASE postgres FROM server_login');
    await db.query('DROP ROLE server_login');
    await db.end();
    await rm(directory, { recursive: true, force: true });
});

for (const [name, local, mode] of [
    ['full local config', settings, 0o600],
    [
        'defaults, production and local overrides',
        {
            port: 0,
            database: { user: database.user, password, database: database.database },
            admin_password: settings.admin_password,
        },
        0o640,
    ],
] as const) {
    test(`server starts with ${name} and stops cleanly`, { timeout: 10000 }, async () => {
        await writeFile(path, JSON.stringify(local), { mode: 0o600 });
        await chmod(path, mode);
        const server = spawn(process.execPath, ['src/server.ts'], { env, timeout: 5000 });
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
            await chmod(path, 0o600);
        }
    });
}

for (const [name, overrides] of [
    ['wrong password', { password: 'wrong-password' }],
    ['missing password', { password: undefined }],
    ['empty password', { password: '' }],
    ['null host', { host: null }],
    ['Unix socket host', { host: '/var/run/postgresql' }],
    ['null user', { user: null }],
    ['null database', { database: null }],
    ['null port', { port: null }],
    ['string port', { port: String(database.port) }],
    ['out-of-range port', { port: 65536 }],
    ['null pool size', { maxPoolSize: null }],
    ['zero pool size', { maxPoolSize: 0 }],
    ['negative pool size', { maxPoolSize: -1 }],
    ['fractional pool size', { maxPoolSize: 1.5 }],
    ['string pool size', { maxPoolSize: '10' }],
    ['privileged role', { user: 'postgres', password: process.env.PGPASSWORD }],
] as const) {
    test(`server rejects ${name} without logging secrets`, async () => {
        await writeFile(path, JSON.stringify({ ...settings, database: { ...database, ...overrides } }));
        const result = spawnSync(process.execPath, ['src/server.ts'], { env, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'control_plane_failed\n');
    });
}

for (const mode of [0o644, 0o620, 0o604]) {
    test(`server rejects secret config mode ${mode.toString(8)} without logging secrets`, async () => {
        await writeFile(path, JSON.stringify(settings));
        await chmod(path, mode);

        try {
            const result = spawnSync(process.execPath, ['src/server.ts'], { env, encoding: 'utf8', timeout: 5000 });
            assert.equal(result.status, 1);
            assert.equal(result.stdout, '');
            assert.equal(result.stderr, 'control_plane_failed\n');
        } finally {
            await chmod(path, 0o600);
        }
    });
}

for (const [name, overrides] of [
    ['missing origin', { origin: undefined }],
    ['missing admin password', { admin_password: undefined }],
    ['short admin password', { admin_password: 'short' }],
    ['public listen host', { listen_host: '0.0.0.0' }],
] as const) {
    test(`server rejects ${name} without logging secrets`, async () => {
        await writeFile(path, JSON.stringify({ ...settings, ...overrides }));
        const result = spawnSync(process.execPath, ['src/server.ts'], {
            env: { ...env, NODE_ENV: 'development', NODE_CONFIG_ENV: 'development' },
            encoding: 'utf8',
            timeout: 5000,
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'control_plane_failed\n');
    });
}

test('server checks secret permissions in overridden sources too', async () => {
    await writeFile(path, JSON.stringify(settings));
    const override = join(directory, 'local-production.json');
    await writeFile(override, JSON.stringify({ admin_password: 'overridden-secret' }), { mode: 0o640 });
    await chmod(path, 0o644);

    try {
        const result = spawnSync(process.execPath, ['src/server.ts'], { env, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'control_plane_failed\n');
    } finally {
        await chmod(path, 0o600);
        await rm(override);
    }
});

test('server hides malformed config parser errors', async () => {
    await writeFile(path, '{"admin_password": "secret-that-must-not-be-logged", broken}');
    const result = spawnSync(process.execPath, ['src/server.ts'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'control_plane_failed\n');
});
