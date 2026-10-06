type Failure = 'not_found' | 'unauthorized' | 'forbidden' | 'invalid_report' | 'state_conflict';

export class NodeError extends Error {
    reason: Failure;

    constructor(reason: Failure) {
        super(reason);
        this.reason = reason;
    }
}
