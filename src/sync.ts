import type { PoolClient } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { digest, HttpError, object, secret } from './protocol.ts';
import { checked, maxRevision, same, state, uuidPattern } from './snapshot.ts';
import type { State, StoredSnapshot } from './snapshot.ts';

const reference = object({ revision: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, snapshot_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } });
const nullableRef = { anyOf: [{ type: 'null' }, reference] };
export const reportSchema = object({
  node_id: { type: 'string', pattern: uuidPattern }, saved: nullableRef, verified: nullableRef,
  error: { anyOf: [{ type: 'null' }, object({ target: nullableRef,
    stage: { enum: ['transport', 'protocol', 'validate', 'persist', 'apply', 'verify', 'recovery'] },
    code: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
  })] },
});
export type Report = { node_id: string; saved: State | null; verified: State | null;
  error: { target: State | null; stage: string; code: string } | null };

export async function synchronize(db: PoolClient, authorization: string, report: Report) {
  const raw = secret(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
  if (!raw) throw new HttpError(401);
  const hash = digest(raw);
  const { rows: [node] } = await db.query('SELECT id,agent_secret_hash,public_connection FROM nodes WHERE agent_secret_hash=$1 FOR UPDATE', [hash]);
  if (!node || !timingSafeEqual(hash, node.agent_secret_hash)) throw new HttpError(401);
  if (node.id !== report.node_id) throw new HttpError(403);
  for (const ref of [report.saved, report.verified, report.error?.target]) {
    if (ref && BigInt(ref.revision) > maxRevision) throw new HttpError(400);
  }
  if (report.verified && !same(report.saved, report.verified)) throw new HttpError(400);
  const { rows: [row] } = await db.query('SELECT * FROM node_sync WHERE node_id=$1 FOR UPDATE', [node.id]);
  const desired = checked(row.desired_snapshot, node.id, node.public_connection.inbound_tag);
  const sent: StoredSnapshot | null = row.sent_snapshot && checked(row.sent_snapshot, node.id, node.public_connection.inbound_tag);
  let confirmed: StoredSnapshot | null = row.confirmed_snapshot && checked(row.confirmed_snapshot, node.id, node.public_connection.inbound_tag);
  const known = [desired, sent, confirmed].filter((s): s is StoredSnapshot => !!s);
  // Never silently repair a restored/corrupt database by lowering any revision.
  for (const a of known) {
    if (BigInt(a.revision) > BigInt(desired.revision)) throw new HttpError(409);
    for (const b of known) if (a.revision === b.revision && !same(a, b)) throw new HttpError(409);
  }
  for (const ref of [report.saved, report.verified]) {
    if (!ref) continue;
    if (BigInt(ref.revision) > BigInt(desired.revision)) throw new HttpError(409);
    for (const s of known) if (s.revision === ref.revision && !same(s, ref)) throw new HttpError(409);
  }
  let ack = 'none';
  if (report.verified) {
    if (same(report.verified, confirmed)) ack = 'already_confirmed';
    else if (confirmed && BigInt(report.verified.revision) < BigInt(confirmed.revision)) ack = 'ignored_stale';
    else if (same(report.verified, sent)) { ack = 'accepted'; confirmed = sent; }
    else if (BigInt(report.verified.revision) < BigInt(desired.revision)) ack = 'unrecognized';
    else throw new HttpError(409);
  }
  const upToDate = same(report.verified, desired) && ['accepted', 'already_confirmed'].includes(ack);
  await db.query(`UPDATE node_sync SET confirmed_snapshot=$2,
    confirmed_at=CASE WHEN $3 THEN clock_timestamp() ELSE confirmed_at END,
    sent_snapshot=$4,last_received_report=$5,last_seen_at=clock_timestamp() WHERE node_id=$1`,
    [node.id, confirmed, ack === 'accepted', upToDate ? sent : desired, report]);
  return { status: upToDate ? 'up_to_date' : 'snapshot', desired: state(desired), ack_status: ack,
    poll_after_seconds: 15, ...(upToDate ? {} : { snapshot: desired.snapshot }) };
}
