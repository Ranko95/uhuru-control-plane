import type { AccessRepository } from '../../repository.ts';

export type ListUsersDto = Record<string, never>;

export class ListUsersUseCase {
    private readonly repository: Pick<AccessRepository, 'readUsers'>;

    constructor(repository: Pick<AccessRepository, 'readUsers'>) {
        this.repository = repository;
    }

    execute(dto: ListUsersDto) {
        void dto;

        return this.repository.readUsers();
    }
}
