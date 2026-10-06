import { profileReadiness } from '../../readiness.ts';
import type { NodesRepository } from '../../repository.ts';
import type { QueryOptions } from '../../../database.ts';

export type ListReadyNodesDto = { id: string; vless_uuid: string };

export class ListReadyNodesUseCase {
    private readonly repository: Pick<NodesRepository, 'readIncludedNodes'>;

    constructor(repository: Pick<NodesRepository, 'readIncludedNodes'>) {
        this.repository = repository;
    }

    async execute(dto: ListReadyNodesDto, options: QueryOptions = {}) {
        return (await this.repository.readIncludedNodes(options))
            .filter((n) => profileReadiness(n, dto).ready)
            .map((n) => ({
                id: n.id,
                label: n.label,
                public_connection: n.public_connection,
            }));
    }
}
