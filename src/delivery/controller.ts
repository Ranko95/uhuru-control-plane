import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../protocol.ts';
import { secret } from '../secrets.ts';
import type { GetConfigurationsUseCase } from './useCases/getConfigurations/getConfigurations.useCase.ts';
import roscomvpnDefault from './roscomvpn-default.json' with { type: 'json' };

export class DeliveryController {
    private readonly getConfigurationsUseCase: GetConfigurationsUseCase;

    constructor(getConfigurationsUseCase: GetConfigurationsUseCase) {
        this.getConfigurationsUseCase = getConfigurationsUseCase;
    }

    async getConfigurations(req: FastifyRequest<{ Params: { secret: string } }>, reply: FastifyReply) {
        // Check the wire encoding, including URL escaping, before a database lookup.
        if (req.raw.url !== '/s/' + req.params.secret) {
            throw new HttpError(404);
        }

        const raw = secret(req.params.secret);

        if (!raw) {
            throw new HttpError(404);
        }

        const result = await this.getConfigurationsUseCase.execute({ linkSecret: raw });
        const routingHeader =
            'happ://routing/onadd/' +
            Buffer.from(
                JSON.stringify({
                    ...roscomvpnDefault,
                    Name: 'Uhuru DEFAULT',
                }),
            ).toString('base64');

        return reply
            .header('Routing', routingHeader)
            .header('Profile-Update-Interval', '24')
            .type('text/plain; charset=utf-8')
            .send(result);
    }
}
