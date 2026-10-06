import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { Pool } from 'pg';

import { HttpError, parseJson } from './protocol.ts';
import { digest } from './secrets.ts';
import { AccessDistribution } from './access-distribution.ts';

import { DeliveryController } from './delivery/controller.ts';
import { deliveryRouter } from './delivery/delivery.router.ts';
import { GetConfigurationsUseCase } from './delivery/useCases/getConfigurations/getConfigurations.useCase.ts';
import { AccessController } from './access/controller.ts';
import { accessRouter } from './access/access.router.ts';
import { AccessRepository } from './access/repository.ts';
import { AccessError } from './access/error.ts';
import { CreateUserUseCase } from './access/useCases/createUser/createUser.useCase.ts';
import { ListUsersUseCase } from './access/useCases/listUsers/listUsers.useCase.ts';
import { GetPlanUseCase } from './access/useCases/getPlan/getPlan.useCase.ts';
import { IssueFirstProfileUseCase } from './access/useCases/issueFirstProfile/issueFirstProfile.useCase.ts';
import { ShowProfileLinkUseCase } from './access/useCases/showProfileLink/showProfileLink.useCase.ts';
import { ListProfilesUseCase } from './access/useCases/listProfiles/listProfiles.useCase.ts';
import { GetProfileAccessUseCase } from './access/useCases/getProfileAccess/getProfileAccess.useCase.ts';
import { AuthorizeSubscriptionLinkUseCase } from './access/useCases/authorizeSubscriptionLink/authorizeSubscriptionLink.useCase.ts';
import { NodesController, NodesAgentController } from './nodes/controller.ts';
import { nodesRouter, nodesAgentRouter } from './nodes/nodes.router.ts';
import { NodesRepository } from './nodes/repository.ts';
import { ListNodesUseCase } from './nodes/useCases/listNodes/listNodes.useCase.ts';
import { RegisterNodeUseCase } from './nodes/useCases/registerNode/registerNode.useCase.ts';
import { RotateBearerUseCase } from './nodes/useCases/rotateBearer/rotateBearer.useCase.ts';
import { GetProfileReadinessUseCase } from './nodes/useCases/getProfileReadiness/getProfileReadiness.useCase.ts';
import { SynchronizeUseCase } from './nodes/useCases/synchronize/synchronize.useCase.ts';
import { ListReadyNodesUseCase } from './nodes/useCases/listReadyNodes/listReadyNodes.useCase.ts';
import { NodeError } from './nodes/error.ts';

export function buildApp(options: { pool: Pool; origin: string; adminUsername: string; adminPassword: string }) {
    const origin = new URL(options.origin);

    if (
        origin.protocol !== 'https:' ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        !options.adminUsername ||
        options.adminUsername.includes(':') ||
        options.adminPassword.length < 16
    ) {
        throw new Error('invalid_settings');
    }

    const { pool } = options;

    const accessRepository = new AccessRepository(pool);
    const nodesRepository = new NodesRepository(pool);
    const accessDistribution = new AccessDistribution(nodesRepository, accessRepository);
    const accessController = new AccessController(
        new CreateUserUseCase(accessRepository),
        new ListUsersUseCase(accessRepository),
        new GetPlanUseCase(accessRepository),
        new IssueFirstProfileUseCase(pool, accessRepository, accessDistribution, origin.origin),
        new ShowProfileLinkUseCase(pool, accessRepository, origin.origin),
        new ListProfilesUseCase(accessRepository),
    );
    const getProfileAccessUseCase = new GetProfileAccessUseCase(accessRepository);

    const nodesController = new NodesController(
        new ListNodesUseCase(nodesRepository),
        new RegisterNodeUseCase(pool, accessDistribution),
        new RotateBearerUseCase(nodesRepository),
        new GetProfileReadinessUseCase(nodesRepository, getProfileAccessUseCase),
    );
    const nodesAgentController = new NodesAgentController(
        new SynchronizeUseCase(pool, nodesRepository, accessDistribution),
    );
    const deliveryController = new DeliveryController(
        new GetConfigurationsUseCase(
            pool,
            new AuthorizeSubscriptionLinkUseCase(accessRepository),
            new ListReadyNodesUseCase(nodesRepository),
        ),
    );

    const adminHash = digest(
        `Basic ${Buffer.from(`${options.adminUsername}:${options.adminPassword}`).toString('base64')}`,
    );

    const app = Fastify({
        logger: false,
        bodyLimit: 2 * 1024 * 1024,
        ajv: {
            customOptions: {
                removeAdditional: false,
                coerceTypes: false,
                useDefaults: false,
            },
        },
    });

    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        try {
            done(null, parseJson(body as string));
        } catch {
            done(new HttpError(400));
        }
    });

    app.addHook('onRequest', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    });

    app.setErrorHandler((error, _req, reply) => {
        const e = error as { statusCode?: number; code?: string };

        const accessStatus =
            error instanceof AccessError
                ? { not_found: 404, profile_limit: 409, revoked: 410, expired: 403 }[error.reason]
                : undefined;

        const nodeStatus =
            error instanceof NodeError
                ? {
                      not_found: 404,
                      unauthorized: 401,
                      forbidden: 403,
                      invalid_report: 400,
                      state_conflict: 409,
                  }[error.reason]
                : undefined;

        let status = accessStatus ?? nodeStatus;

        if (status === undefined) {
            if (e.code === '23505') {
                status = 409;
            } else if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
                status = e.statusCode;
            } else {
                status = 503;
            }
        }

        if (status === 503) {
            reply.header('Retry-After', '15');
        }

        if (status === 401 && !reply.hasHeader('WWW-Authenticate')) {
            reply.header('WWW-Authenticate', 'Bearer');
        }

        reply.code(status).send({
            error: status === 503 ? 'temporarily_unavailable' : 'request_rejected',
        });
    });

    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

    app.register(
        async (admin) => {
            admin.addHook('onRequest', async (req, reply) => {
                if (!timingSafeEqual(digest(req.headers.authorization ?? ''), adminHash)) {
                    reply.header('WWW-Authenticate', 'Basic realm="Uhuru", charset="UTF-8"');
                    throw new HttpError(401);
                }
            });

            admin.register(accessRouter, { controller: accessController });
            admin.register(nodesRouter, { controller: nodesController });
        },
        { prefix: '/admin' },
    );

    app.register(nodesAgentRouter, { prefix: '/agent/v1', controller: nodesAgentController });
    app.register(deliveryRouter, { controller: deliveryController });

    return app;
}
