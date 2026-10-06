import type { Pool } from 'pg';
import { transaction } from '../../../database.ts';
import { profileLink } from '../../profile.ts';
import type { AccessRepository } from '../../repository.ts';

export type ShowProfileLinkDto = { profileId: string };

export class ShowProfileLinkUseCase {
    private readonly pool: Pool;
    private readonly repository: Pick<AccessRepository, 'readProfileLink'>;
    private readonly origin: string;

    constructor(pool: Pool, repository: Pick<AccessRepository, 'readProfileLink'>, origin: string) {
        this.pool = pool;
        this.repository = repository;
        this.origin = origin;
    }

    execute(dto: ShowProfileLinkDto) {
        return transaction(this.pool, (tx) => profileLink(this.repository, dto.profileId, this.origin, { tx }));
    }
}
