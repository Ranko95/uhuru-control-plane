import type { Pool } from 'pg';
import { transaction } from '../database.ts';
import { AccessDistribution } from '../access-distribution.ts';
import { NodesRepository } from '../nodes/repository.ts';
import { AccessRepository } from './repository.ts';

type AccessTransaction = {
    repository: AccessRepository;
    accessDistribution: AccessDistribution;
};

export class AccessUnitOfWork {
    private readonly pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    transaction<T>(work: (scope: AccessTransaction) => Promise<T>): Promise<T> {
        return transaction(this.pool, (db) => {
            const repository = new AccessRepository(db);

            return work({
                repository,
                accessDistribution: new AccessDistribution(new NodesRepository(db), repository),
            });
        });
    }
}
