import { AccessError } from './error.ts';
import type { AccessRepository, AccessState } from './repository.ts';
import type { QueryOptions } from '../database.ts';

export function status(value: AccessState) {
    if (value.revoked_at) {
        return 'revoked';
    }

    return value.within_term ? 'active' : 'expired';
}

export async function profileLink(
    repository: Pick<AccessRepository, 'readProfileLink'>,
    profileId: string,
    origin: string,
    options: QueryOptions = {},
) {
    const profile = await repository.readProfileLink(profileId, options);

    if (!profile) {
        throw new AccessError('not_found');
    }

    const { link_secret, revoked_at, within_term, ...visible } = profile;
    const commercialStatus = status({ revoked_at, within_term });

    return {
        ...visible,
        status: commercialStatus,
        ...(commercialStatus === 'revoked' ? {} : { link: origin + '/s/' + link_secret.toString('base64url') }),
    };
}
