import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digest } from './secrets.ts';
import { checked, snapshot } from './snapshot.ts';
import type { Profile } from './snapshot.ts';
import * as accessRepository from './access/repository.ts';
import type { Connection } from './nodes/model.ts';
import * as nodeRepository from './nodes/repository.ts';

// The caller owns the transaction and, for issuance, the User lock and retry check.
export async function distributeAccessChange<T>(
  db: PoolClient,
  change: (time: string) => Promise<T>,
) {
  await accessRepository.lockIssuance(db);
  const nodes = await nodeRepository.lockDesiredNodes(db);
  const time = await accessRepository.readTime(db);
  const result = await change(time);
  const profiles = await accessRepository.readDesiredProfiles(db, time);
  for (const node of nodes) {
    await updateDesiredSnapshot(db, node, profiles);
  }
  return result;
}

// The caller holds this Node and its sync-state lock before reading current DB time.
export async function refreshNodeAccess(
  db: PoolClient,
  node: nodeRepository.DesiredNode,
) {
  return updateDesiredSnapshot(
    db,
    node,
    await accessRepository.readDesiredProfiles(db),
  );
}

async function updateDesiredSnapshot(
  db: PoolClient,
  node: nodeRepository.DesiredNode,
  profiles: Profile[],
) {
  const old = checked(
    node.desired_snapshot,
    node.id,
    node.public_connection.inbound_tag,
  );
  if (JSON.stringify(old.snapshot.users) === JSON.stringify(profiles))
    return old;
  const next = snapshot(
    node.id,
    old.snapshot.inbound_tag,
    String(BigInt(old.revision) + 1n),
    profiles,
  );
  await nodeRepository.writeDesiredSnapshot(db, node.id, next);
  return next;
}

export async function enrollNode(
  db: PoolClient,
  label: string,
  connection: Connection,
  bearer: Buffer,
) {
  await accessRepository.lockIssuance(db);
  const profiles = await accessRepository.readDesiredProfiles(db);
  const id = randomUUID();
  await nodeRepository.insertNode(db, {
    id,
    label,
    connection,
    secretHash: digest(bearer),
  });
  await nodeRepository.insertSyncState(
    db,
    id,
    snapshot(id, connection.inbound_tag, '1', profiles),
  );
  return { id, label };
}
