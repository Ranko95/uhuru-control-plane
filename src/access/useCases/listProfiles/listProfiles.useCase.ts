import { status } from '../../profile.ts';
import type { AccessRepository } from '../../repository.ts';

export type ListProfilesDto = { userId: string };

export class ListProfilesUseCase {
    private readonly repository: Pick<AccessRepository, 'readProfiles'>;

    constructor(repository: Pick<AccessRepository, 'readProfiles'>) {
        this.repository = repository;
    }

    async execute(dto: ListProfilesDto) {
        return (await this.repository.readProfiles(dto.userId)).map((p) => ({
            id: p.id,
            revoked_at: p.revoked_at,
            status: status(p),
        }));
    }
}
