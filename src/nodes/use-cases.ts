import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { enrollNode } from '../access-distribution.ts';
import { transaction } from '../database.ts';
import type { Database } from '../database.ts';
import { digest } from '../secrets.ts';
import { checked, maxRevision, same, state } from '../snapshot.ts';
import type { StoredSnapshot } from '../snapshot.ts';
import { getProfileAccess } from '../access/use-cases.ts';
import type { Connection, Report } from './model.ts';
import { profileReadiness } from './readiness.ts';
import * as repository from './repository.ts';

type Failure = 'not_found' | 'unauthorized' | 'forbidden' | 'invalid_report' | 'state_conflict';
export class NodeError extends Error {
  reason: Failure;
  constructor(reason: Failure) { super(reason); this.reason = reason; }
}

export async function registerNode(pool: Pool, label: string, connection: Connection, bearer: Buffer) {
  return transaction(pool, db => enrollNode(db, label, connection, bearer));
}

export async function rotateBearer(pool: Pool, nodeId: string, bearer: Buffer) {
  if (!await repository.replaceSecretHash(pool, nodeId, digest(bearer))) throw new NodeError('not_found');
}
export async function listNodes(db: Database) { return repository.readNodes(db); }

export async function getProfileReadiness(db: Database, profileId: string) {
  const profile = await getProfileAccess(db, profileId);
  return (await repository.readReadinessNodes(db)).map(n => ({
    id: n.id, label: n.label, include_in_subscription: n.include_in_subscription,
    ...profileReadiness(n, profile), desired_access: profile.active,
    confirmed_at: n.confirmed_at, last_seen_at: n.last_seen_at, last_received_report: n.last_received_report,
  }));
}

export async function listReadyNodes(db: PoolClient, profile: { id: string; vless_uuid: string }) {
  return (await repository.readIncludedNodes(db))
    .filter(n => profileReadiness(n, profile).ready)
    .map(n => ({ id: n.id, label: n.label, public_connection: n.public_connection }));
}

export async function synchronize(pool: Pool, bearer: Buffer, report: Report) {
  return transaction(pool, async db => {
    const hash = digest(bearer);
    const node = await repository.lockNodeBySecretHash(db, hash);
    if (!node || !timingSafeEqual(hash, node.agent_secret_hash)) throw new NodeError('unauthorized');
    if (node.id !== report.node_id) throw new NodeError('forbidden');
    for (const ref of [report.saved, report.verified, report.error?.target]) {
      if (ref && BigInt(ref.revision) > maxRevision) throw new NodeError('invalid_report');
    }
    if (report.verified && !same(report.saved, report.verified)) throw new NodeError('invalid_report');
    const row = await repository.lockSyncState(db, node.id);
    const desired = checked(row.desired_snapshot, node.id, node.public_connection.inbound_tag);
    const sent = row.sent_snapshot && checked(row.sent_snapshot, node.id, node.public_connection.inbound_tag);
    let confirmed = row.confirmed_snapshot && checked(row.confirmed_snapshot, node.id, node.public_connection.inbound_tag);
    const known = [desired, sent, confirmed].filter((s): s is StoredSnapshot => !!s);
    // Never silently repair a restored/corrupt database by lowering any revision.
    for (const a of known) {
      if (BigInt(a.revision) > BigInt(desired.revision)) throw new NodeError('state_conflict');
      for (const b of known) if (a.revision === b.revision && !same(a, b)) throw new NodeError('state_conflict');
    }
    for (const ref of [report.saved, report.verified]) {
      if (!ref) continue;
      if (BigInt(ref.revision) > BigInt(desired.revision)) throw new NodeError('state_conflict');
      for (const s of known) if (s.revision === ref.revision && !same(s, ref)) throw new NodeError('state_conflict');
    }
    let ack = 'none';
    if (report.verified) {
      if (same(report.verified, confirmed)) ack = 'already_confirmed';
      else if (confirmed && BigInt(report.verified.revision) < BigInt(confirmed.revision)) ack = 'ignored_stale';
      else if (same(report.verified, sent)) { ack = 'accepted'; confirmed = sent; }
      else if (BigInt(report.verified.revision) < BigInt(desired.revision)) ack = 'unrecognized';
      else throw new NodeError('state_conflict');
    }
    const upToDate = same(report.verified, desired) && ['accepted', 'already_confirmed'].includes(ack);
    // ACK provenance is checked against the previous sent snapshot before recording this response.
    await repository.writeSyncResult(db, node.id, {
      confirmed, newlyConfirmed: ack === 'accepted', sent: upToDate ? sent : desired, report,
    });
    return { status: upToDate ? 'up_to_date' : 'snapshot', desired: state(desired), ack_status: ack,
      poll_after_seconds: 15, ...(upToDate ? {} : { snapshot: desired.snapshot }) };
  });
}
