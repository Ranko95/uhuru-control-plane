import { digest } from '../../../secrets.ts';
import { NodeError } from '../../error.ts';
import type { NodesRepository } from '../../repository.ts';

export type RotateBearerDto = { nodeId: string; bearer: Buffer };

export class RotateBearerUseCase {
    private readonly repository: Pick<NodesRepository, 'replaceSecretHash'>;

    constructor(repository: Pick<NodesRepository, 'replaceSecretHash'>) {
        this.repository = repository;
    }

    async execute(dto: RotateBearerDto) {
        if (!(await this.repository.replaceSecretHash(dto.nodeId, digest(dto.bearer)))) {
            throw new NodeError('not_found');
        }
    }
}
