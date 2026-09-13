import { checked, state } from '../snapshot.ts';
import type { StoredSnapshot } from '../snapshot.ts';
import type { Connection } from './model.ts';

export function profileReadiness(
  node: { id: string; public_connection: Connection; confirmed_snapshot: StoredSnapshot | null },
  profile: { id: string; vless_uuid: string },
) {
  const confirmed = node.confirmed_snapshot && checked(node.confirmed_snapshot, node.id, node.public_connection.inbound_tag);
  return {
    ready: !!confirmed?.snapshot.users.some(p => p.profile_id === profile.id && p.vless_uuid === profile.vless_uuid),
    confirmed: confirmed ? state(confirmed) : null,
  };
}
