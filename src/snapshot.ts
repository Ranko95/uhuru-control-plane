import { createHash } from 'node:crypto';

export const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const maxRevision = 9223372036854775807n;
export type State = { revision: string; snapshot_hash: string };
export type Profile = { profile_id: string; vless_uuid: string };
export type Snapshot = { node_id: string; revision: string; inbound_tag: string; users: Profile[] };
export type StoredSnapshot = State & { snapshot: Snapshot };

export function snapshot(nodeId: string, inbound: string, revision: string, profiles: Profile[]): StoredSnapshot {
  if (!/^[1-9][0-9]{0,18}$/.test(revision) || BigInt(revision) > maxRevision) throw new Error('invalid_revision');
  if (!new RegExp(uuidPattern).test(nodeId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(inbound) || profiles.length > 10_000) {
    throw new Error('invalid_snapshot');
  }
  const ids = new Set<string>(), credentials = new Set<string>();
  const users = profiles.map(p => {
    if (!new RegExp(uuidPattern).test(p.profile_id) || !new RegExp(uuidPattern).test(p.vless_uuid)
      || Object.keys(p).sort().join() !== 'profile_id,vless_uuid' || ids.has(p.profile_id) || credentials.has(p.vless_uuid)) {
      throw new Error('invalid_profiles');
    }
    ids.add(p.profile_id); credentials.add(p.vless_uuid);
    return { profile_id: p.profile_id, vless_uuid: p.vless_uuid };
  }).sort((a, b) => a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0);
  // This closed schema has only ASCII strings; these literal keys are in JCS order.
  const value = { inbound_tag: inbound, node_id: nodeId, revision, users };
  return { revision, snapshot_hash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), snapshot: value };
}

export function checked(value: StoredSnapshot, nodeId: string, inbound: string): StoredSnapshot {
  if (Object.keys(value).sort().join() !== 'revision,snapshot,snapshot_hash'
    || Object.keys(value.snapshot).sort().join() !== 'inbound_tag,node_id,revision,users'
    || value.snapshot.node_id !== nodeId || value.snapshot.inbound_tag !== inbound || value.snapshot.revision !== value.revision) {
    throw new Error('corrupt_snapshot');
  }
  const canonical = snapshot(nodeId, inbound, value.revision, value.snapshot.users);
  if (canonical.snapshot_hash !== value.snapshot_hash) throw new Error('corrupt_snapshot');
  return canonical;
}

export function same(a: State | null, b: State | null): boolean {
  return !!a && !!b && a.revision === b.revision && a.snapshot_hash === b.snapshot_hash;
}

export function state(value: State): State {
  return { revision: value.revision, snapshot_hash: value.snapshot_hash };
}
