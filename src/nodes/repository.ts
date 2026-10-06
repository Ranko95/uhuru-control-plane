import type { Database } from '../database.ts';
import type { Connection, Diagnostics, NodeSummary, PublicNode, Report } from './model.ts';
import type { StoredSnapshot } from '../snapshot.ts';

export type DesiredNode = {
    id: string;
    public_connection: { inbound_tag: string };
    desired_snapshot: StoredSnapshot;
};

type SyncState = {
    desired_snapshot: StoredSnapshot;
    sent_snapshot: StoredSnapshot | null;
    confirmed_snapshot: StoredSnapshot | null;
};

type ReadinessNode = PublicNode & Diagnostics & { confirmed_snapshot: StoredSnapshot | null };

export class NodesRepository {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    async readNodes(): Promise<NodeSummary[]> {
        return (
            await this.db.query<NodeSummary>(
                `SELECT n.id, n.label, n.public_connection, n.include_in_subscription,
                    s.confirmed_at, s.last_seen_at, s.last_received_report,
                    s.desired_snapshot ->> 'revision' AS desired_revision,
                    s.confirmed_snapshot ->> 'revision' AS confirmed_revision
             FROM nodes n
             JOIN node_sync s ON s.node_id = n.id
             ORDER BY n.id`,
            )
        ).rows;
    }

    async lockDesiredNodes() {
        return (
            await this.db.query<DesiredNode>(
                `SELECT n.id, n.public_connection, s.desired_snapshot
                 FROM nodes n
                 JOIN node_sync s ON s.node_id = n.id
                 ORDER BY n.id
                 FOR UPDATE OF n, s`,
            )
        ).rows;
    }

    async writeDesiredSnapshot(nodeId: string, value: StoredSnapshot) {
        await this.db.query('UPDATE node_sync SET desired_snapshot = $2 WHERE node_id = $1', [nodeId, value]);
    }

    async insertNode(node: { id: string; label: string; connection: Connection; secretHash: Buffer }) {
        await this.db.query(
            `INSERT INTO nodes(id, label, public_connection, agent_secret_hash)
             VALUES ($1, $2, $3, $4)`,
            [node.id, node.label, node.connection, node.secretHash],
        );
    }

    async insertSyncState(nodeId: string, value: StoredSnapshot) {
        await this.db.query('INSERT INTO node_sync(node_id, desired_snapshot) VALUES ($1, $2)', [nodeId, value]);
    }

    async replaceSecretHash(nodeId: string, hash: Buffer) {
        return !!(await this.db.query('UPDATE nodes SET agent_secret_hash = $2 WHERE id = $1', [nodeId, hash]))
            .rowCount;
    }

    async readReadinessNodes() {
        return (
            await this.db.query<ReadinessNode>(
                `SELECT n.id, n.label, n.public_connection, n.include_in_subscription, s.confirmed_snapshot,
                        s.confirmed_at, s.last_seen_at, s.last_received_report
                 FROM nodes n
                 JOIN node_sync s ON s.node_id = n.id
                 ORDER BY n.id`,
            )
        ).rows;
    }

    async readIncludedNodes() {
        return (
            await this.db.query<Pick<ReadinessNode, 'id' | 'label' | 'public_connection' | 'confirmed_snapshot'>>(
                `SELECT n.id, n.label, n.public_connection, s.confirmed_snapshot
                 FROM nodes n
                 JOIN node_sync s ON s.node_id = n.id
                 WHERE n.include_in_subscription
                 ORDER BY n.id`,
            )
        ).rows;
    }

    async lockNodeBySecretHash(hash: Buffer) {
        return (
            await this.db.query<{
                id: string;
                agent_secret_hash: Buffer;
                public_connection: Connection;
            }>(
                `SELECT id, agent_secret_hash, public_connection
                 FROM nodes
                 WHERE agent_secret_hash = $1
                 FOR UPDATE`,
                [hash],
            )
        ).rows[0];
    }

    async lockSyncState(nodeId: string) {
        return (
            await this.db.query<SyncState>(
                `SELECT desired_snapshot, sent_snapshot, confirmed_snapshot
                 FROM node_sync
                 WHERE node_id = $1
                 FOR UPDATE`,
                [nodeId],
            )
        ).rows[0];
    }

    async writeSyncResult(
        nodeId: string,
        result: {
            confirmed: StoredSnapshot | null;
            newlyConfirmed: boolean;
            sent: StoredSnapshot | null;
            report: Report;
        },
    ) {
        await this.db.query(
            `UPDATE node_sync
             SET confirmed_snapshot = $2,
                 confirmed_at = CASE WHEN $3 THEN clock_timestamp() ELSE confirmed_at END,
                 sent_snapshot = $4,
                 last_received_report = $5,
                 last_seen_at = clock_timestamp()
             WHERE node_id = $1`,
            [nodeId, result.confirmed, result.newlyConfirmed, result.sent, result.report],
        );
    }
}
