import type { Pool } from 'pg';
import { transaction } from '../database.ts';
import { AccessDistribution } from '../access-distribution.ts';
import { AccessRepository } from '../access/repository.ts';
import { NodesRepository } from './repository.ts';

type NodeTransaction = {
    repository: NodesRepository;
    accessDistribution: AccessDistribution;
};

export class NodesUnitOfWork {
    private readonly pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    transaction<T>(work: (scope: NodeTransaction) => Promise<T>): Promise<T> {
        return transaction(this.pool, (db) => {
            const repository = new NodesRepository(db);

            return work({
                repository,
                accessDistribution: new AccessDistribution(repository, new AccessRepository(db)),
            });
        });
    }
}
