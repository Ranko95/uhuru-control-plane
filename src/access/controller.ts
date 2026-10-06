import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CreateUserUseCase } from './useCases/createUser/createUser.useCase.ts';
import type { ListUsersUseCase } from './useCases/listUsers/listUsers.useCase.ts';
import type { GetPlanUseCase } from './useCases/getPlan/getPlan.useCase.ts';
import type { IssueFirstProfileUseCase } from './useCases/issueFirstProfile/issueFirstProfile.useCase.ts';
import type { ShowProfileLinkUseCase } from './useCases/showProfileLink/showProfileLink.useCase.ts';
import type { ListProfilesUseCase } from './useCases/listProfiles/listProfiles.useCase.ts';

export class AccessController {
    private readonly createUserUseCase: CreateUserUseCase;
    private readonly listUsersUseCase: ListUsersUseCase;
    private readonly getPlanUseCase: GetPlanUseCase;
    private readonly issueFirstProfileUseCase: IssueFirstProfileUseCase;
    private readonly showProfileLinkUseCase: ShowProfileLinkUseCase;
    private readonly listProfilesUseCase: ListProfilesUseCase;

    constructor(
        createUserUseCase: CreateUserUseCase,
        listUsersUseCase: ListUsersUseCase,
        getPlanUseCase: GetPlanUseCase,
        issueFirstProfileUseCase: IssueFirstProfileUseCase,
        showProfileLinkUseCase: ShowProfileLinkUseCase,
        listProfilesUseCase: ListProfilesUseCase,
    ) {
        this.createUserUseCase = createUserUseCase;
        this.listUsersUseCase = listUsersUseCase;
        this.getPlanUseCase = getPlanUseCase;
        this.issueFirstProfileUseCase = issueFirstProfileUseCase;
        this.showProfileLinkUseCase = showProfileLinkUseCase;
        this.listProfilesUseCase = listProfilesUseCase;
    }

    async createUser(req: FastifyRequest<{ Body: { label: string } }>, reply: FastifyReply) {
        const user = await this.createUserUseCase.execute({ label: req.body.label.trim() });

        return reply.code(201).send(user);
    }

    async listUsers(_req: FastifyRequest, reply: FastifyReply) {
        const users = await this.listUsersUseCase.execute({});

        return reply.send(users);
    }

    async getPlan(_req: FastifyRequest, reply: FastifyReply) {
        const plan = await this.getPlanUseCase.execute({});

        return reply.send(plan);
    }

    async issueFirstProfile(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
        const profile = await this.issueFirstProfileUseCase.execute({ userId: req.params.id });

        return reply.send(profile);
    }

    async showProfileLink(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
        const profile = await this.showProfileLinkUseCase.execute({ profileId: req.params.id });

        return reply.send(profile);
    }

    async listProfiles(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
        const profiles = await this.listProfilesUseCase.execute({ userId: req.params.id });

        return reply.send(profiles);
    }
}
