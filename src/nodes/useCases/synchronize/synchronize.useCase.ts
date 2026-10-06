import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../../database.ts';
import type { AccessDistribution } from '../../../access-distribution.ts';
import { digest } from '../../../secrets.ts';
import { checked, maxRevision, same, state } from '../../../snapshot.ts';
import type { StoredSnapshot } from '../../../snapshot.ts';
import type { NodesRepository } from '../../repository.ts';
import { NodeError } from '../../error.ts';
import type { Report } from '../../model.ts';

export type SynchronizeDto = { bearer: Buffer; report: Report };

export class SynchronizeUseCase {
    private readonly pool: Pool;
    private readonly repository: Pick<NodesRepository, 'lockNodeBySecretHash' | 'lockSyncState' | 'writeSyncResult'>;
    private readonly accessDistribution: Pick<AccessDistribution, 'refreshNodeAccess'>;

    constructor(
        pool: Pool,
        repository: Pick<NodesRepository, 'lockNodeBySecretHash' | 'lockSyncState' | 'writeSyncResult'>,
        accessDistribution: Pick<AccessDistribution, 'refreshNodeAccess'>,
    ) {
        this.pool = pool;
        this.repository = repository;
        this.accessDistribution = accessDistribution;
    }

    execute(dto: SynchronizeDto) {
        return transaction(this.pool, async (tx) => {
            const options = { tx };
            const { repository, accessDistribution } = this;
            const hash = digest(dto.bearer);
            const node = await repository.lockNodeBySecretHash(hash, options);

            if (!node || !timingSafeEqual(hash, node.agent_secret_hash)) {
                throw new NodeError('unauthorized');
            }

            if (node.id !== dto.report.node_id) {
                throw new NodeError('forbidden');
            }

            for (const ref of [dto.report.saved, dto.report.verified, dto.report.error?.target]) {
                if (ref && BigInt(ref.revision) > maxRevision) {
                    throw new NodeError('invalid_report');
                }
            }

            if (dto.report.verified && !same(dto.report.saved, dto.report.verified)) {
                throw new NodeError('invalid_report');
            }

            const row = await repository.lockSyncState(node.id, options);
            let desired = checked(row.desired_snapshot, node.id, node.public_connection.inbound_tag);
            const sent = row.sent_snapshot && checked(row.sent_snapshot, node.id, node.public_connection.inbound_tag);
            let confirmed =
                row.confirmed_snapshot && checked(row.confirmed_snapshot, node.id, node.public_connection.inbound_tag);
            const knownSnapshots = [desired, sent, confirmed].filter((value): value is StoredSnapshot => !!value);

            // Never silently repair a restored/corrupt database by lowering any revision.
            for (const knownSnapshot of knownSnapshots) {
                if (BigInt(knownSnapshot.revision) > BigInt(desired.revision)) {
                    throw new NodeError('state_conflict');
                }

                for (const otherSnapshot of knownSnapshots) {
                    if (knownSnapshot.revision === otherSnapshot.revision && !same(knownSnapshot, otherSnapshot)) {
                        throw new NodeError('state_conflict');
                    }
                }
            }

            desired = await accessDistribution.refreshNodeAccess(
                { node: { ...node, desired_snapshot: desired } },
                options,
            );
            knownSnapshots[0] = desired;

            for (const ref of [dto.report.saved, dto.report.verified]) {
                if (!ref) {
                    continue;
                }

                if (BigInt(ref.revision) > BigInt(desired.revision)) {
                    throw new NodeError('state_conflict');
                }

                for (const knownSnapshot of knownSnapshots) {
                    if (knownSnapshot.revision === ref.revision && !same(knownSnapshot, ref)) {
                        throw new NodeError('state_conflict');
                    }
                }
            }

            let ack = 'none';

            if (dto.report.verified) {
                if (same(dto.report.verified, confirmed)) {
                    ack = 'already_confirmed';
                } else if (confirmed && BigInt(dto.report.verified.revision) < BigInt(confirmed.revision)) {
                    ack = 'ignored_stale';
                } else if (same(dto.report.verified, sent)) {
                    ack = 'accepted';
                    confirmed = sent;
                } else if (BigInt(dto.report.verified.revision) < BigInt(desired.revision)) {
                    ack = 'unrecognized';
                } else {
                    throw new NodeError('state_conflict');
                }
            }

            const upToDate = same(dto.report.verified, desired) && ['accepted', 'already_confirmed'].includes(ack);

            // ACK provenance is checked against the previous sent snapshot before recording this response.
            await repository.writeSyncResult(
                node.id,
                {
                    confirmed,
                    newlyConfirmed: ack === 'accepted',
                    sent: upToDate ? sent : desired,
                    report: dto.report,
                },
                options,
            );

            return {
                status: upToDate ? 'up_to_date' : 'snapshot',
                desired: state(desired),
                ack_status: ack,
                poll_after_seconds: 15,
                ...(upToDate ? {} : { snapshot: desired.snapshot }),
            };
        });
    }
}
