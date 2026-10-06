import type { FastifyPluginAsync } from 'fastify';
import { object } from '../protocol.ts';
import { uuidPattern } from '../snapshot.ts';
import type { AccessController } from './controller.ts';

const idParams = object({ id: { type: 'string', pattern: uuidPattern } });

export const accessRouter: FastifyPluginAsync<{ controller: AccessController }> = async (app, { controller }) => {
    app.post<{ Body: { label: string } }>(
        '/users',
        {
            schema: {
                body: object({
                    label: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 200,
                        pattern: '\\S',
                    },
                }),
            },
        },
        (req, reply) => controller.createUser(req, reply),
    );

    app.get('/users', (req, reply) => controller.listUsers(req, reply));

    app.get('/plan', (req, reply) => controller.getPlan(req, reply));

    app.post<{ Params: { id: string } }>('/users/:id/first-profile', { schema: { params: idParams } }, (req, reply) =>
        controller.issueFirstProfile(req, reply),
    );

    app.post<{ Params: { id: string } }>('/profiles/:id/link', { schema: { params: idParams } }, (req, reply) =>
        controller.showProfileLink(req, reply),
    );

    app.get<{ Params: { id: string } }>('/users/:id/profiles', { schema: { params: idParams } }, (req, reply) =>
        controller.listProfiles(req, reply),
    );
};
