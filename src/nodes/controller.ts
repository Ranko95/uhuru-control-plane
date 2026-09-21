import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { HttpError, object } from '../protocol.ts';
import { secret } from '../secrets.ts';
import { uuidPattern } from '../snapshot.ts';
import type { Connection, Report } from './model.ts';
import * as nodes from './use-cases.ts';

const idParams = object({ id: { type: 'string', pattern: uuidPattern } });
const connectionSchema = object({
  inbound_tag: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' },
  host: { type: 'string', maxLength: 253, pattern: '^[a-zA-Z0-9.-]+$' },
  port: { type: 'integer', minimum: 1, maximum: 65535 },
  server_name: { type: 'string', maxLength: 253, pattern: '^[a-zA-Z0-9.-]+$' },
  public_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  short_id: { type: 'string', pattern: '^(?:[0-9a-f]{2}){1,8}$' },
  fingerprint: { enum: ['chrome'] },
});
const reference = object({
  revision: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
  snapshot_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
});
const nullableRef = { anyOf: [{ type: 'null' }, reference] };
const reportSchema = object({
  node_id: { type: 'string', pattern: uuidPattern },
  saved: nullableRef,
  verified: nullableRef,
  error: {
    anyOf: [
      { type: 'null' },
      object({
        target: nullableRef,
        stage: {
          enum: [
            'transport',
            'protocol',
            'validate',
            'persist',
            'apply',
            'verify',
            'recovery',
          ],
        },
        code: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
      }),
    ],
  },
});

export const nodeAdminController: FastifyPluginAsync<{ pool: Pool }> = async (
  app,
  { pool },
) => {
  app.post<{
    Body: { label: string; public_connection: Connection; bearer: string };
  }>(
    '/nodes',
    {
      schema: {
        body: object({
          label: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            pattern: '\\S',
          },
          public_connection: connectionSchema,
          bearer: { type: 'string' },
        }),
      },
    },
    async (req, reply) => {
      const raw = secret(req.body.bearer);
      if (!raw || !secret(req.body.public_connection.public_key))
        throw new HttpError(400);
      return reply
        .code(201)
        .send(
          await nodes.registerNode(
            pool,
            req.body.label.trim(),
            req.body.public_connection,
            raw,
          ),
        );
    },
  );
  app.put<{ Params: { id: string }; Body: { bearer: string } }>(
    '/nodes/:id/bearer',
    {
      schema: {
        params: idParams,
        body: object({ bearer: { type: 'string' } }),
      },
    },
    async (req, reply) => {
      const raw = secret(req.body.bearer);
      if (!raw) throw new HttpError(400);
      await nodes.rotateBearer(pool, req.params.id, raw);
      return reply.code(204).send();
    },
  );
  app.get('/nodes', async () => nodes.listNodes(pool));
  app.get<{ Params: { id: string } }>(
    '/profiles/:id/readiness',
    { schema: { params: idParams } },
    async (req) => nodes.getProfileReadiness(pool, req.params.id),
  );
};

export const nodeAgentController: FastifyPluginAsync<{ pool: Pool }> = async (
  app,
  { pool },
) => {
  app.post<{ Body: Report }>(
    '/sync',
    { schema: { body: reportSchema } },
    async (req) => {
      const authorization = req.headers.authorization ?? '';
      const raw = secret(
        authorization.startsWith('Bearer ') ? authorization.slice(7) : '',
      );
      if (!raw) throw new HttpError(401);
      return nodes.synchronize(pool, raw, req.body);
    },
  );
};
