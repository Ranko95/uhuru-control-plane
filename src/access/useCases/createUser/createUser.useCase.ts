import { randomUUID } from 'node:crypto';
import type { AccessRepository } from '../../repository.ts';

export type CreateUserDto = { label: string };

export class CreateUserUseCase {
    private readonly repository: Pick<AccessRepository, 'insertUser'>;

    constructor(repository: Pick<AccessRepository, 'insertUser'>) {
        this.repository = repository;
    }

    async execute(dto: CreateUserDto) {
        const user = { id: randomUUID(), label: dto.label };

        await this.repository.insertUser(user);

        return user;
    }
}
