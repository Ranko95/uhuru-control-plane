import type { PoolClient } from 'pg';
import type { Database } from '../database.ts';

export type AccessState = { revoked_at: Date | null; within_term: boolean | null };
type ProfileAccess = AccessState & { id: string; vless_uuid: string };
type ProfileLink = AccessState & {
  profile_id: string; link_secret: Buffer; first_profile_id: string; starts_at: Date; ends_at: Date;
};

export async function insertUser(db: Database, user: { id: string; label: string }) {
  await db.query('INSERT INTO users(id,label) VALUES ($1,$2)', [user.id, user.label]);
}
export async function readUsers(db: Database) {
  return (await db.query<{ id: string; label: string }>('SELECT id,label FROM users ORDER BY id')).rows;
}
export async function readPlan(db: Database) {
  return (await db.query('SELECT * FROM service_settings WHERE id=1')).rows[0];
}
export async function lockUser(db: PoolClient, userId: string) {
  return !!(await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId])).rowCount;
}
export async function readFirstProfile(db: PoolClient, userId: string) {
  return (await db.query<{ first_profile_id: string }>(
    'SELECT first_profile_id FROM subscriptions WHERE user_id=$1', [userId])).rows[0];
}
export async function lockIssuance(db: PoolClient) {
  // ponytail: one topology/issuance lock; separate enrollment serialization if pilot throughput demands it.
  await db.query('SELECT id FROM service_settings WHERE id=1 FOR UPDATE');
}
export async function readTime(db: PoolClient) {
  return (await db.query<{ t: string }>('SELECT clock_timestamp()::text AS t')).rows[0].t;
}
export async function countUnrevokedProfiles(db: PoolClient, userId: string) {
  return (await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM access_profiles WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows[0].count;
}
export async function insertProfile(db: PoolClient, id: string, userId: string, credential: string, linkSecret: Buffer) {
  await db.query('INSERT INTO access_profiles(id,user_id,vless_uuid,link_secret) VALUES ($1,$2,$3,$4)',
    [id, userId, credential, linkSecret]);
}
export async function insertSubscription(db: PoolClient, userId: string, profileId: string, time: string, durationHours: number) {
  await db.query("INSERT INTO subscriptions(user_id,first_profile_id,starts_at,ends_at) "
    + "VALUES ($1,$2,$3::timestamptz,$3::timestamptz+$4::integer*interval '1 hour')",
  [userId, profileId, time, durationHours]);
}
export async function readDesiredProfiles(db: PoolClient, time?: string) {
  return (await db.query<{ profile_id: string; vless_uuid: string }>(
    'SELECT * FROM active_profiles(COALESCE($1::timestamptz,clock_timestamp()))', [time ?? null])).rows;
}
export async function readProfileLink(db: PoolClient, profileId: string) {
  return (await db.query<ProfileLink>(
    'SELECT p.id AS profile_id,p.link_secret,p.revoked_at,s.first_profile_id,s.starts_at,s.ends_at,'
    + 'clock_timestamp()<s.ends_at AS within_term FROM access_profiles p '
    + 'JOIN subscriptions s ON s.user_id=p.user_id WHERE p.id=$1', [profileId])).rows[0];
}
export async function readProfiles(db: Database, userId: string) {
  return (await db.query<AccessState & { id: string }>(
    'SELECT p.id,p.revoked_at,clock_timestamp()<s.ends_at AS within_term FROM access_profiles p '
    + 'LEFT JOIN subscriptions s ON s.user_id=p.user_id WHERE p.user_id=$1 ORDER BY p.id', [userId])).rows;
}
export async function readProfileAccess(db: Database, profileId: string) {
  return (await db.query<ProfileAccess>(
    'SELECT p.id,p.vless_uuid,p.revoked_at,clock_timestamp()<s.ends_at AS within_term FROM access_profiles p '
    + 'JOIN subscriptions s ON s.user_id=p.user_id WHERE p.id=$1', [profileId])).rows[0];
}
export async function readProfileBySecret(db: PoolClient, linkSecret: Buffer) {
  return (await db.query<ProfileAccess>(
    'SELECT p.id,p.vless_uuid,p.revoked_at,clock_timestamp()<s.ends_at AS within_term FROM access_profiles p '
    + 'JOIN subscriptions s ON s.user_id=p.user_id WHERE p.link_secret=$1', [linkSecret])).rows[0];
}
