import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../../database.ts';
import type { AccessDistribution } from '../../../access-distribution.ts';
import { AccessError } from '../../error.ts';
import { profileLink } from '../../profile.ts';
import type { AccessRepository } from '../../repository.ts';

export type IssueFirstProfileDto = { userId: string };

export class IssueFirstProfileUseCase {
    private readonly pool: Pool;
    private readonly repository: Pick<
        AccessRepository,
        | 'lockUser'
        | 'readFirstProfile'
        | 'countUnrevokedProfiles'
        | 'insertProfile'
        | 'insertSubscription'
        | 'readProfileLink'
    >;
    private readonly accessDistribution: Pick<AccessDistribution, 'distributeAccessChange'>;
    private readonly origin: string;

    constructor(
        pool: Pool,
        repository: IssueFirstProfileUseCase['repository'],
        accessDistribution: Pick<AccessDistribution, 'distributeAccessChange'>,
        origin: string,
    ) {
        this.pool = pool;
        this.repository = repository;
        this.accessDistribution = accessDistribution;
        this.origin = origin;
    }

    execute(dto: IssueFirstProfileDto) {
        return transaction(this.pool, async (tx) => {
            const options = { tx };
            const { repository, accessDistribution } = this;

            if (!(await repository.lockUser(dto.userId, options))) {
                throw new AccessError('not_found');
            }

            const existing = await repository.readFirstProfile(dto.userId, options);

            if (existing) {
                return profileLink(repository, existing.first_profile_id, this.origin, options);
            }

            const id = await accessDistribution.distributeAccessChange(
                {
                    change: async (time) => {
                        if ((await repository.countUnrevokedProfiles(dto.userId, options)) >= 3) {
                            throw new AccessError('profile_limit');
                        }

                        const id = randomUUID();

                        await repository.insertProfile(id, dto.userId, randomUUID(), randomBytes(32), options);
                        await repository.insertSubscription(dto.userId, id, time, 720, options);

                        return id;
                    },
                },
                options,
            );

            return profileLink(repository, id, this.origin, options);
        });
    }
}
