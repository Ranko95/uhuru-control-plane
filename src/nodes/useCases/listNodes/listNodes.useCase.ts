import type { NodeSummary } from '../../model.ts';
import type { NodesRepository } from '../../repository.ts';

export type ListNodesDto = Record<string, never>;

export class ListNodesUseCase {
    private readonly repository: Pick<NodesRepository, 'readNodes'>;

    constructor(repository: Pick<NodesRepository, 'readNodes'>) {
        this.repository = repository;
    }

    execute(dto: ListNodesDto): Promise<NodeSummary[]> {
        void dto;

        return this.repository.readNodes();
    }
}
