import { AccessError } from '../../error.ts';
import { status } from '../../profile.ts';
import type { AccessRepository } from '../../repository.ts';

export type GetProfileAccessDto = { profileId: string };

export class GetProfileAccessUseCase {
    private readonly repository: Pick<AccessRepository, 'readProfileAccess'>;

    constructor(repository: Pick<AccessRepository, 'readProfileAccess'>) {
        this.repository = repository;
    }

    async execute(dto: GetProfileAccessDto) {
        const profile = await this.repository.readProfileAccess(dto.profileId);

        if (!profile) {
            throw new AccessError('not_found');
        }

        return { id: profile.id, vless_uuid: profile.vless_uuid, active: status(profile) === 'active' };
    }
}
