type Failure = 'not_found' | 'profile_limit' | 'revoked' | 'expired';

export class AccessError extends Error {
    reason: Failure;

    constructor(reason: Failure) {
        super(reason);
        this.reason = reason;
    }
}
