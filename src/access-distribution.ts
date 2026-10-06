import { randomUUID } from 'node:crypto';
import { digest } from './secrets.ts';
import { checked, snapshot } from './snapshot.ts';
import type { Profile } from './snapshot.ts';
import type { AccessRepository } from './access/repository.ts';
import type { Connection } from './nodes/model.ts';
import type { NodesRepository } from './nodes/repository.ts';
import type { DesiredNode } from './nodes/repository.ts';

export type DistributeAccessChangeDto<T> = { change: (time: string) => Promise<T> };
export type RefreshNodeAccessDto = { node: DesiredNode };
export type EnrollNodeDto = { label: string; connection: Connection; bearer: Buffer };

export class AccessDistribution {
    private readonly nodesRepository: NodesRepository;
    private readonly accessRepository: Pick<AccessRepository, 'lockIssuance' | 'readTime' | 'readDesiredProfiles'>;

    constructor(
        nodesRepository: NodesRepository,
        accessRepository: Pick<AccessRepository, 'lockIssuance' | 'readTime' | 'readDesiredProfiles'>,
    ) {
        this.nodesRepository = nodesRepository;
        this.accessRepository = accessRepository;
    }

    // The caller owns the transaction and, for issuance, the User lock and retry check.
    async distributeAccessChange<T>(dto: DistributeAccessChangeDto<T>) {
        await this.accessRepository.lockIssuance();
        const nodes = await this.nodesRepository.lockDesiredNodes();
        const time = await this.accessRepository.readTime();

        const result = await dto.change(time);
        const profiles = await this.accessRepository.readDesiredProfiles(time);

        for (const node of nodes) {
            await this.updateDesiredSnapshot(node, profiles);
        }

        return result;
    }

    // The caller holds this Node and its sync-state lock before reading current DB time.
    async refreshNodeAccess(dto: RefreshNodeAccessDto) {
        return this.updateDesiredSnapshot(dto.node, await this.accessRepository.readDesiredProfiles());
    }

    private async updateDesiredSnapshot(node: DesiredNode, profiles: Profile[]) {
        const old = checked(node.desired_snapshot, node.id, node.public_connection.inbound_tag);

        if (JSON.stringify(old.snapshot.users) === JSON.stringify(profiles)) {
            return old;
        }

        const next = snapshot(node.id, old.snapshot.inbound_tag, String(BigInt(old.revision) + 1n), profiles);
        await this.nodesRepository.writeDesiredSnapshot(node.id, next);

        return next;
    }

    async enrollNode(dto: EnrollNodeDto) {
        await this.accessRepository.lockIssuance();
        const profiles = await this.accessRepository.readDesiredProfiles();

        const id = randomUUID();
        await this.nodesRepository.insertNode({
            id,
            label: dto.label,
            connection: dto.connection,
            secretHash: digest(dto.bearer),
        });
        await this.nodesRepository.insertSyncState(id, snapshot(id, dto.connection.inbound_tag, '1', profiles));

        return { id, label: dto.label };
    }
}
