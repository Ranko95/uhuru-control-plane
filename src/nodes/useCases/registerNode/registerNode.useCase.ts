import type { Pool } from 'pg';
import { transaction } from '../../../database.ts';
import type { AccessDistribution } from '../../../access-distribution.ts';
import type { Connection } from '../../model.ts';

export type RegisterNodeDto = {
    label: string;
    connection: Connection;
    bearer: Buffer;
};

export class RegisterNodeUseCase {
    private readonly pool: Pool;
    private readonly accessDistribution: Pick<AccessDistribution, 'enrollNode'>;

    constructor(pool: Pool, accessDistribution: Pick<AccessDistribution, 'enrollNode'>) {
        this.pool = pool;
        this.accessDistribution = accessDistribution;
    }

    execute(dto: RegisterNodeDto) {
        return transaction(this.pool, (tx) => this.accessDistribution.enrollNode(dto, { tx }));
    }
}
