import type { FastifyPluginAsync } from 'fastify';
import { object } from '../protocol.ts';
import { uuidPattern } from '../snapshot.ts';
import type { Connection, Report } from './model.ts';
import type { NodesController, NodesAgentController } from './controller.ts';

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
                    enum: ['transport', 'protocol', 'validate', 'persist', 'apply', 'verify', 'recovery'],
                },
                code: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
            }),
        ],
    },
});

export const nodesRouter: FastifyPluginAsync<{ controller: NodesController }> = async (app, { controller }) => {
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
        (req, reply) => controller.registerNode(req, reply),
    );

    app.put<{ Params: { id: string }; Body: { bearer: string } }>(
        '/nodes/:id/bearer',
        {
            schema: {
                params: idParams,
                body: object({ bearer: { type: 'string' } }),
            },
        },
        (req, reply) => controller.rotateBearer(req, reply),
    );

    app.get('/nodes', (req, reply) => controller.listNodes(req, reply));

    app.get<{ Params: { id: string } }>('/profiles/:id/readiness', { schema: { params: idParams } }, (req, reply) =>
        controller.getProfileReadiness(req, reply),
    );
};

export const nodesAgentRouter: FastifyPluginAsync<{ controller: NodesAgentController }> = async (
    app,
    { controller },
) => {
    app.post<{ Body: Report }>('/sync', { schema: { body: reportSchema } }, (req, reply) =>
        controller.synchronize(req, reply),
    );
};
