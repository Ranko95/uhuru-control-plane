import { profileLink } from '../../profile.ts';
import type { AccessUnitOfWork } from '../../unit-of-work.ts';

export type ShowProfileLinkDto = { profileId: string };

export class ShowProfileLinkUseCase {
    private readonly unitOfWork: Pick<AccessUnitOfWork, 'transaction'>;
    private readonly origin: string;

    constructor(unitOfWork: Pick<AccessUnitOfWork, 'transaction'>, origin: string) {
        this.unitOfWork = unitOfWork;
        this.origin = origin;
    }

    execute(dto: ShowProfileLinkDto) {
        return this.unitOfWork.transaction(({ repository }) => profileLink(repository, dto.profileId, this.origin));
    }
}
