import { profileReadiness } from '../../readiness.ts';
import type { NodesRepository } from '../../repository.ts';
import type { GetProfileAccessUseCase } from '../../../access/useCases/getProfileAccess/getProfileAccess.useCase.ts';

export type GetProfileReadinessDto = { profileId: string };

export class GetProfileReadinessUseCase {
    private readonly repository: Pick<NodesRepository, 'readReadinessNodes'>;
    private readonly getProfileAccessUseCase: Pick<GetProfileAccessUseCase, 'execute'>;

    constructor(
        repository: Pick<NodesRepository, 'readReadinessNodes'>,
        getProfileAccessUseCase: Pick<GetProfileAccessUseCase, 'execute'>,
    ) {
        this.repository = repository;
        this.getProfileAccessUseCase = getProfileAccessUseCase;
    }

    async execute(dto: GetProfileReadinessDto) {
        const profile = await this.getProfileAccessUseCase.execute(dto);

        return (await this.repository.readReadinessNodes()).map((n) => ({
            id: n.id,
            label: n.label,
            include_in_subscription: n.include_in_subscription,
            ...profileReadiness(n, profile),
            desired_access: profile.active,
            confirmed_at: n.confirmed_at,
            last_seen_at: n.last_seen_at,
            last_received_report: n.last_received_report,
        }));
    }
}
