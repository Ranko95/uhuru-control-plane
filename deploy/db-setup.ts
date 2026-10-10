// Prepares the uhuru database from an administrator connection taken from the PG* environment:
// creates the missing database, applies pending migrations and sets the application role
// password when the role has none. Run as a script, it reads the password from piped stdin.
import { fileURLToPath } from 'node:url';
import { text } from 'node:stream/consumers';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

const DATABASE = 'uhuru';
const ROLE = 'uhuru';
const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

export async function prepareDatabase(password?: string): Promise<string[]> {
    const admin = new pg.Client({ database: 'postgres' });
    await admin.connect();

    try {
        const { rowCount } = await admin.query('SELECT FROM pg_database WHERE datname = $1', [DATABASE]);

        if (!rowCount) {
            await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(DATABASE)}`);
        }
    } finally {
        await admin.end();
    }

    const db = new pg.Client({ database: DATABASE });
    await db.connect();

    try {
        const applied = await runner({
            dbClient: db,
            dir: MIGRATIONS,
            direction: 'up',
            migrationsTable: 'pgmigrations',
            log: () => {},
        });

        if (password) {
            await setPasswordIfMissing(db, password);
        }

        return applied.map((migration) => migration.name);
    } finally {
        await db.end();
    }
}

async function setPasswordIfMissing(db: pg.Client, password: string) {
    try {
        const { rows } = await db.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [ROLE]);

        if (rows[0]?.rolpassword === null) {
            await db.query("SET password_encryption = 'scram-sha-256'");
            await db.query(`ALTER ROLE ${pg.escapeIdentifier(ROLE)} PASSWORD ${pg.escapeLiteral(password)}`);
        }
    } catch {
        // Never surface the error text: the statement carries the password.
        throw new Error('database_setup_failed');
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const password = process.stdin.isTTY ? '' : (await text(process.stdin)).replace(/\r?\n$/, '');

    try {
        for (const name of await prepareDatabase(password)) {
            process.stdout.write(`Applied ${name}\n`);
        }
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'migration_failed'}\n`);
        process.exitCode = 1;
    }
}
