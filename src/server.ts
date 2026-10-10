import { readFile, stat } from 'node:fs/promises';
import pg from 'pg';

import { buildApp } from './app.ts';

process.umask(0o077);

function fatal() {
    process.stderr.write('control_plane_failed\n');
    process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

try {
    const path = process.argv[2];

    if (!path || ((await stat(path)).mode & 0o037) !== 0) {
        throw new Error('private_settings_required');
    }

    const settings = JSON.parse(await readFile(path, 'utf8'));
    const database = settings.database;

    if (
        !database ||
        typeof database.host !== 'string' ||
        !database.host.trim() ||
        database.host.startsWith('/') ||
        !Number.isInteger(database.port) ||
        database.port < 1 ||
        database.port > 65535 ||
        typeof database.user !== 'string' ||
        !database.user.trim() ||
        typeof database.password !== 'string' ||
        !database.password ||
        typeof database.database !== 'string' ||
        !database.database.trim() ||
        !Number.isSafeInteger(database.maxPoolSize) ||
        database.maxPoolSize < 1
    ) {
        throw new Error('invalid_database_settings');
    }

    if (settings.listen_host && settings.listen_host !== '127.0.0.1') {
        throw new Error('loopback_required');
    }

    const pool = new pg.Pool({
        host: database.host,
        port: database.port,
        user: database.user,
        password: database.password,
        database: database.database,
        max: database.maxPoolSize,
    });

    pool.on('error', () => process.stderr.write('database_unavailable\n'));

    const {
        rows: [role],
    } = await pool.query(
        'SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user',
    );

    if (!role || Object.values(role).some(Boolean)) {
        throw new Error('restricted_role_required');
    }

    const app = buildApp({
        pool,
        origin: settings.origin,
        adminUsername: settings.admin_username,
        adminPassword: settings.admin_password,
    });

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            void app
                .close()
                .then(() => pool.end())
                .then(() => process.exit(0));
        });
    }

    await app.listen({
        host: '127.0.0.1',
        port: settings.port ?? 8080,
    });

    process.stdout.write('control_plane_started\n');
} catch {
    fatal();
}
