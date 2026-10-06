import type { AccessRepository } from '../../repository.ts';

export type GetPlanDto = Record<string, never>;

export class GetPlanUseCase {
    private readonly repository: Pick<AccessRepository, 'readPlan'>;

    constructor(repository: Pick<AccessRepository, 'readPlan'>) {
        this.repository = repository;
    }

    execute(dto: GetPlanDto) {
        void dto;

        return this.repository.readPlan();
    }
}
