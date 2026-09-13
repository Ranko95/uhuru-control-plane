import type { PoolClient } from 'pg';
import { checked, snapshot } from '../snapshot.ts';
import type { Profile } from '../snapshot.ts';
import { lockDesiredNodes, writeDesiredSnapshot } from './repository.ts';

// Lock before reading issuance time; the returned update uses the same transaction.
export async function lockDesiredAccess(db: PoolClient) {
  const nodes = await lockDesiredNodes(db);
  return async (profiles: Profile[]) => {
    for (const node of nodes) {
      const old = checked(node.desired_snapshot, node.id, node.public_connection.inbound_tag);
      if (JSON.stringify(old.snapshot.users) !== JSON.stringify(profiles)) {
        const next = snapshot(node.id, old.snapshot.inbound_tag, String(BigInt(old.revision) + 1n), profiles);
        await writeDesiredSnapshot(db, node.id, next);
      }
    }
  };
}
