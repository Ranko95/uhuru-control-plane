import type { Pool } from 'pg';
import { transaction } from '../database.ts';
import { AccessRepository } from '../access/repository.ts';
import { AuthorizeSubscriptionLinkUseCase } from '../access/useCases/authorizeSubscriptionLink/authorizeSubscriptionLink.useCase.ts';
import { NodesRepository } from '../nodes/repository.ts';
import { ListReadyNodesUseCase } from '../nodes/useCases/listReadyNodes/listReadyNodes.useCase.ts';

type DeliveryTransaction = {
    authorizeSubscriptionLinkUseCase: AuthorizeSubscriptionLinkUseCase;
    listReadyNodesUseCase: ListReadyNodesUseCase;
};

export class DeliveryUnitOfWork {
    private readonly pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    transaction<T>(work: (scope: DeliveryTransaction) => Promise<T>): Promise<T> {
        return transaction(this.pool, (db) =>
            work({
                authorizeSubscriptionLinkUseCase: new AuthorizeSubscriptionLinkUseCase(new AccessRepository(db)),
                listReadyNodesUseCase: new ListReadyNodesUseCase(new NodesRepository(db)),
            }),
        );
    }
}
