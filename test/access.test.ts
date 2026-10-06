import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ListUsersUseCase } from '../src/access/useCases/listUsers/listUsers.useCase.ts';

test('listing Users returns IDs and labels from the injected repository', async () => {
    const users = [{ id: '11111111-1111-4111-8111-111111111111', label: 'Injected User' }];
    const useCase = new ListUsersUseCase({ readUsers: async () => users });

    assert.deepEqual(await useCase.execute({}), users);
});
