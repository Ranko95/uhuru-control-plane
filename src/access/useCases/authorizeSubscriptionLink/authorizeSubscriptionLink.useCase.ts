import { AccessError } from '../../error.ts';
import { status } from '../../profile.ts';
import type { AccessRepository } from '../../repository.ts';
import type { QueryOptions } from '../../../database.ts';

export type AuthorizeSubscriptionLinkDto = { linkSecret: Buffer };

export class AuthorizeSubscriptionLinkUseCase {
    private readonly repository: Pick<AccessRepository, 'readProfileBySecret'>;

    constructor(repository: Pick<AccessRepository, 'readProfileBySecret'>) {
        this.repository = repository;
    }

    async execute(dto: AuthorizeSubscriptionLinkDto, options: QueryOptions = {}) {
        const profile = await this.repository.readProfileBySecret(dto.linkSecret, options);

        if (!profile) {
            throw new AccessError('not_found');
        }

        const commercialStatus = status(profile);

        if (commercialStatus === 'revoked' || commercialStatus === 'expired') {
            throw new AccessError(commercialStatus);
        }

        return { id: profile.id, vless_uuid: profile.vless_uuid };
    }
}
