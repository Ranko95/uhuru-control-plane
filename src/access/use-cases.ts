import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { distributeAccessChange } from '../access-distribution.ts';
import { transaction } from '../database.ts';
import type { Database } from '../database.ts';
import * as repository from './repository.ts';

type Failure = 'not_found' | 'profile_limit' | 'revoked' | 'expired';
export class AccessError extends Error {
  reason: Failure;
  constructor(reason: Failure) {
    super(reason);
    this.reason = reason;
  }
}

function status(value: repository.AccessState) {
  return value.revoked_at
    ? 'revoked'
    : value.within_term
      ? 'active'
      : 'expired';
}

export async function createUser(db: Database, label: string) {
  const user = { id: randomUUID(), label };
  await repository.insertUser(db, user);
  return user;
}
export async function listUsers(db: Database) {
  return repository.readUsers(db);
}
export async function getPlan(db: Database) {
  return repository.readPlan(db);
}

async function profileLink(db: PoolClient, profileId: string, origin: string) {
  const profile = await repository.readProfileLink(db, profileId);
  if (!profile) throw new AccessError('not_found');
  const { link_secret, revoked_at, within_term, ...visible } = profile;
  const commercialStatus = status({ revoked_at, within_term });
  return {
    ...visible,
    status: commercialStatus,
    ...(commercialStatus === 'revoked'
      ? {}
      : { link: origin + '/s/' + link_secret.toString('base64url') }),
  };
}

export async function issueFirstProfile(
  pool: Pool,
  userId: string,
  origin: string,
) {
  return transaction(pool, async (db) => {
    if (!(await repository.lockUser(db, userId)))
      throw new AccessError('not_found');
    const existing = await repository.readFirstProfile(db, userId);
    if (existing) return profileLink(db, existing.first_profile_id, origin);
    const id = await distributeAccessChange(db, async (time) => {
      if ((await repository.countUnrevokedProfiles(db, userId)) >= 3)
        throw new AccessError('profile_limit');
      const id = randomUUID();
      await repository.insertProfile(
        db,
        id,
        userId,
        randomUUID(),
        randomBytes(32),
      );
      await repository.insertSubscription(db, userId, id, time, 720);
      return id;
    });
    return profileLink(db, id, origin);
  });
}

export async function showProfileLink(
  pool: Pool,
  profileId: string,
  origin: string,
) {
  return transaction(pool, (db) => profileLink(db, profileId, origin));
}
export async function listProfiles(db: Database, userId: string) {
  return (await repository.readProfiles(db, userId)).map((p) => ({
    id: p.id,
    revoked_at: p.revoked_at,
    status: status(p),
  }));
}

// Internal reads for readiness and configuration delivery.
export async function getProfileAccess(db: Database, profileId: string) {
  const p = await repository.readProfileAccess(db, profileId);
  if (!p) throw new AccessError('not_found');
  return { id: p.id, vless_uuid: p.vless_uuid, active: status(p) === 'active' };
}
export async function authorizeSubscriptionLink(
  db: PoolClient,
  linkSecret: Buffer,
) {
  const p = await repository.readProfileBySecret(db, linkSecret);
  if (!p) throw new AccessError('not_found');
  const commercialStatus = status(p);
  if (commercialStatus === 'revoked' || commercialStatus === 'expired')
    throw new AccessError(commercialStatus);
  return { id: p.id, vless_uuid: p.vless_uuid };
}
