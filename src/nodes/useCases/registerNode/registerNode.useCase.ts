import type { Connection } from '../../model.ts';
import type { NodesUnitOfWork } from '../../unit-of-work.ts';

export type RegisterNodeDto = {
    label: string;
    connection: Connection;
    bearer: Buffer;
};

export class RegisterNodeUseCase {
    private readonly unitOfWork: Pick<NodesUnitOfWork, 'transaction'>;

    constructor(unitOfWork: Pick<NodesUnitOfWork, 'transaction'>) {
        this.unitOfWork = unitOfWork;
    }

    execute(dto: RegisterNodeDto) {
        return this.unitOfWork.transaction(({ accessDistribution }) => accessDistribution.enrollNode(dto));
    }
}
