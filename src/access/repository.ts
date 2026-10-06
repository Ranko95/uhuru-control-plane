import type { Database, QueryOptions, TransactionOptions } from '../database.ts';

export type AccessState = {
    revoked_at: Date | null;
    within_term: boolean | null;
};

type ProfileAccess = AccessState & { id: string; vless_uuid: string };

type ProfileLink = AccessState & {
    profile_id: string;
    link_secret: Buffer;
    first_profile_id: string;
    starts_at: Date;
    ends_at: Date;
};

export class AccessRepository {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    async insertUser(user: { id: string; label: string }) {
        await this.db.query('INSERT INTO users(id, label) VALUES ($1, $2)', [user.id, user.label]);
    }

    async readUsers() {
        return (await this.db.query<{ id: string; label: string }>('SELECT id, label FROM users ORDER BY id')).rows;
    }

    async readPlan() {
        return (await this.db.query('SELECT * FROM service_settings WHERE id = 1')).rows[0];
    }

    async lockUser(userId: string, options: TransactionOptions) {
        return !!(await options.tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])).rowCount;
    }

    async readFirstProfile(userId: string, options: QueryOptions = {}) {
        const db = options.tx ?? this.db;

        return (
            await db.query<{ first_profile_id: string }>(
                'SELECT first_profile_id FROM subscriptions WHERE user_id = $1',
                [userId],
            )
        ).rows[0];
    }

    async lockIssuance(options: TransactionOptions) {
        // ponytail: one topology/issuance lock; separate enrollment serialization if pilot throughput demands it.
        await options.tx.query('SELECT id FROM service_settings WHERE id = 1 FOR UPDATE');
    }

    async readTime(options: QueryOptions = {}) {
        const db = options.tx ?? this.db;

        return (await db.query<{ t: string }>('SELECT clock_timestamp()::text AS t')).rows[0].t;
    }

    async countUnrevokedProfiles(userId: string, options: QueryOptions = {}) {
        const db = options.tx ?? this.db;

        return (
            await db.query<{ count: number }>(
                `SELECT count(*)::int AS count
                 FROM access_profiles
                 WHERE user_id = $1 AND revoked_at IS NULL`,
                [userId],
            )
        ).rows[0].count;
    }

    async insertProfile(
        id: string,
        userId: string,
        credential: string,
        linkSecret: Buffer,
        options: QueryOptions = {},
    ) {
        const db = options.tx ?? this.db;
        await db.query(
            `INSERT INTO access_profiles(id, user_id, vless_uuid, link_secret)
             VALUES ($1, $2, $3, $4)`,
            [id, userId, credential, linkSecret],
        );
    }

    async insertSubscription(
        userId: string,
        profileId: string,
        time: string,
        durationHours: number,
        options: QueryOptions = {},
    ) {
        const db = options.tx ?? this.db;
        await db.query(
            `INSERT INTO subscriptions(user_id, first_profile_id, starts_at, ends_at)
             VALUES ($1, $2, $3::timestamptz, $3::timestamptz + $4::integer * interval '1 hour')`,
            [userId, profileId, time, durationHours],
        );
    }

    async readDesiredProfiles(time?: string, options: QueryOptions = {}) {
        const db = options.tx ?? this.db;

        return (
            await db.query<{ profile_id: string; vless_uuid: string }>(
                'SELECT * FROM active_profiles(COALESCE($1::timestamptz, clock_timestamp()))',
                [time ?? null],
            )
        ).rows;
    }

    async readProfileLink(profileId: string, options: QueryOptions = {}) {
        const db = options.tx ?? this.db;

        return (
            await db.query<ProfileLink>(
                `SELECT p.id AS profile_id, p.link_secret, p.revoked_at,
                        s.first_profile_id, s.starts_at, s.ends_at,
                        clock_timestamp() < s.ends_at AS within_term
                 FROM access_profiles p
                 JOIN subscriptions s ON s.user_id = p.user_id
                 WHERE p.id = $1`,
                [profileId],
            )
        ).rows[0];
    }

    async readProfiles(userId: string) {
        return (
            await this.db.query<AccessState & { id: string }>(
                `SELECT p.id, p.revoked_at, clock_timestamp() < s.ends_at AS within_term
                 FROM access_profiles p
                 LEFT JOIN subscriptions s ON s.user_id = p.user_id
                 WHERE p.user_id = $1
                 ORDER BY p.id`,
                [userId],
            )
        ).rows;
    }

    async readProfileAccess(profileId: string) {
        return (
            await this.db.query<ProfileAccess>(
                `SELECT p.id, p.vless_uuid, p.revoked_at, clock_timestamp() < s.ends_at AS within_term
                 FROM access_profiles p
                 JOIN subscriptions s ON s.user_id = p.user_id
                 WHERE p.id = $1`,
                [profileId],
            )
        ).rows[0];
    }

    async readProfileBySecret(linkSecret: Buffer, options: QueryOptions = {}) {
        const db = options.tx ?? this.db;

        return (
            await db.query<ProfileAccess>(
                `SELECT p.id, p.vless_uuid, p.revoked_at, clock_timestamp() < s.ends_at AS within_term
                 FROM access_profiles p
                 JOIN subscriptions s ON s.user_id = p.user_id
                 WHERE p.link_secret = $1`,
                [linkSecret],
            )
        ).rows[0];
    }
}
