import { randomBytes, randomUUID } from 'node:crypto';
import { AccessError } from '../../error.ts';
import { profileLink } from '../../profile.ts';
import type { AccessUnitOfWork } from '../../unit-of-work.ts';

export type IssueFirstProfileDto = { userId: string };

export class IssueFirstProfileUseCase {
    private readonly unitOfWork: Pick<AccessUnitOfWork, 'transaction'>;
    private readonly origin: string;

    constructor(unitOfWork: Pick<AccessUnitOfWork, 'transaction'>, origin: string) {
        this.unitOfWork = unitOfWork;
        this.origin = origin;
    }

    execute(dto: IssueFirstProfileDto) {
        return this.unitOfWork.transaction(async ({ repository, accessDistribution }) => {
            if (!(await repository.lockUser(dto.userId))) {
                throw new AccessError('not_found');
            }

            const existing = await repository.readFirstProfile(dto.userId);

            if (existing) {
                return profileLink(repository, existing.first_profile_id, this.origin);
            }

            const id = await accessDistribution.distributeAccessChange({
                change: async (time) => {
                    if ((await repository.countUnrevokedProfiles(dto.userId)) >= 3) {
                        throw new AccessError('profile_limit');
                    }

                    const id = randomUUID();

                    await repository.insertProfile(id, dto.userId, randomUUID(), randomBytes(32));
                    await repository.insertSubscription(dto.userId, id, time, 720);

                    return id;
                },
            });

            return profileLink(repository, id, this.origin);
        });
    }
}
