import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { object } from '../protocol.ts';
import { uuidPattern } from '../snapshot.ts';
import * as access from './use-cases.ts';

const idParams = object({ id: { type: 'string', pattern: uuidPattern } });

export const accessController: FastifyPluginAsync<{ pool: Pool; origin: string }> = async (app, { pool, origin }) => {
  app.post<{ Body: { label: string } }>('/users', {
    schema: { body: object({ label: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } }) },
  }, async (req, reply) => reply.code(201).send(await access.createUser(pool, req.body.label.trim())));
  app.get('/users', async () => access.listUsers(pool));
  app.get('/plan', async () => access.getPlan(pool));
  app.post<{ Params: { id: string } }>('/users/:id/first-profile', { schema: { params: idParams } },
    async req => access.issueFirstProfile(pool, req.params.id, origin));
  app.post<{ Params: { id: string } }>('/profiles/:id/link', { schema: { params: idParams } },
    async req => access.showProfileLink(pool, req.params.id, origin));
  app.get<{ Params: { id: string } }>('/users/:id/profiles', { schema: { params: idParams } },
    async req => access.listProfiles(pool, req.params.id));
};
