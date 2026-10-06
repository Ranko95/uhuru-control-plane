import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../protocol.ts';
import { secret } from '../secrets.ts';
import type { Connection, Report } from './model.ts';
import type { ListNodesUseCase } from './useCases/listNodes/listNodes.useCase.ts';
import type { RegisterNodeUseCase } from './useCases/registerNode/registerNode.useCase.ts';
import type { RotateBearerUseCase } from './useCases/rotateBearer/rotateBearer.useCase.ts';
import type { GetProfileReadinessUseCase } from './useCases/getProfileReadiness/getProfileReadiness.useCase.ts';
import type { SynchronizeUseCase } from './useCases/synchronize/synchronize.useCase.ts';

export class NodesController {
    private readonly listNodesUseCase: ListNodesUseCase;
    private readonly registerNodeUseCase: RegisterNodeUseCase;
    private readonly rotateBearerUseCase: RotateBearerUseCase;
    private readonly getProfileReadinessUseCase: GetProfileReadinessUseCase;

    constructor(
        listNodesUseCase: ListNodesUseCase,
        registerNodeUseCase: RegisterNodeUseCase,
        rotateBearerUseCase: RotateBearerUseCase,
        getProfileReadinessUseCase: GetProfileReadinessUseCase,
    ) {
        this.listNodesUseCase = listNodesUseCase;
        this.registerNodeUseCase = registerNodeUseCase;
        this.rotateBearerUseCase = rotateBearerUseCase;
        this.getProfileReadinessUseCase = getProfileReadinessUseCase;
    }

    async listNodes(_req: FastifyRequest, reply: FastifyReply) {
        const nodes = await this.listNodesUseCase.execute({});

        return reply.send(nodes);
    }

    async registerNode(
        req: FastifyRequest<{ Body: { label: string; public_connection: Connection; bearer: string } }>,
        reply: FastifyReply,
    ) {
        const input = req.body;
        const raw = secret(input.bearer);

        if (!raw || !secret(input.public_connection.public_key)) {
            throw new HttpError(400);
        }

        const node = await this.registerNodeUseCase.execute({
            label: input.label.trim(),
            connection: input.public_connection,
            bearer: raw,
        });

        return reply.code(201).send(node);
    }

    async rotateBearer(req: FastifyRequest<{ Params: { id: string }; Body: { bearer: string } }>, reply: FastifyReply) {
        const raw = secret(req.body.bearer);

        if (!raw) {
            throw new HttpError(400);
        }

        await this.rotateBearerUseCase.execute({ nodeId: req.params.id, bearer: raw });

        return reply.code(204).send();
    }

    async getProfileReadiness(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
        const readiness = await this.getProfileReadinessUseCase.execute({ profileId: req.params.id });

        return reply.send(readiness);
    }
}

export class NodesAgentController {
    private readonly synchronizeUseCase: SynchronizeUseCase;

    constructor(synchronizeUseCase: SynchronizeUseCase) {
        this.synchronizeUseCase = synchronizeUseCase;
    }

    async synchronize(req: FastifyRequest<{ Body: Report }>, reply: FastifyReply) {
        const authorization = req.headers.authorization ?? '';
        const raw = secret(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');

        if (!raw) {
            throw new HttpError(401);
        }

        const result = await this.synchronizeUseCase.execute({ bearer: raw, report: req.body });

        return reply.send(result);
    }
}
