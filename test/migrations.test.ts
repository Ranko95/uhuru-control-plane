import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { prepareDatabase } from '../deploy/db-setup.ts';

async function withClient<T>(config: pg.ClientConfig, action: (client: pg.Client) => Promise<T>) {
    const client = new pg.Client(config);
    await client.connect();

    try {
        return await action(client);
    } finally {
        await client.end();
    }
}

test('prepareDatabase creates the database and role, applies migrations and preserves data and password', async () => {
    assert.equal(process.env.PGHOST, '127.0.0.1');
    const migrations = (await readdir('migrations')).filter((file) => file.endsWith('.sql'));
    const appUser = (password: string) => ({ user: 'uhuru', password, database: 'uhuru' });

    try {
        assert.deepEqual(
            await prepareDatabase('first-password'),
            migrations.map((file) => file.replace(/\.sql$/, '')),
        );
        await withClient({ user: 'postgres', database: 'uhuru' }, async (db) => {
            assert.equal((await db.query('SELECT currency FROM service_settings WHERE id=1')).rows[0].currency, 'RUB');
            const grants = await db.query(`SELECT
                has_table_privilege('uhuru', 'users', 'SELECT,INSERT') AS allowed,
                has_table_privilege('uhuru', 'users', 'DELETE') AS can_delete,
                has_table_privilege('uhuru', 'pgmigrations', 'SELECT') AS can_read_history`);
            assert.deepEqual(grants.rows[0], { allowed: true, can_delete: false, can_read_history: false });
            await db.query("INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000001', 'Preserved')");
        });
        await withClient(appUser('first-password'), async (app) => {
            assert.equal((await app.query('SELECT current_user')).rows[0].current_user, 'uhuru');
        });

        assert.deepEqual(await prepareDatabase('second-password'), []);
        await withClient({ user: 'postgres', database: 'uhuru' }, async (db) => {
            assert.equal((await db.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 1);
            assert.equal(
                (await db.query('SELECT count(*)::int AS count FROM pgmigrations')).rows[0].count,
                migrations.length,
            );
        });
        await withClient(appUser('first-password'), () => Promise.resolve());
        await assert.rejects(withClient(appUser('second-password'), () => Promise.resolve()));
    } finally {
        await withClient({ user: 'postgres', database: 'postgres' }, async (admin) => {
            await admin.query('DROP DATABASE IF EXISTS uhuru WITH (FORCE)');
            await admin.query('DROP ROLE IF EXISTS uhuru');
        });
    }
});
