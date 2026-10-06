import type { FastifyPluginAsync } from 'fastify';
import { object } from '../protocol.ts';
import type { DeliveryController } from './controller.ts';

export const deliveryRouter: FastifyPluginAsync<{ controller: DeliveryController }> = async (app, { controller }) => {
    app.get<{ Params: { secret: string } }>(
        '/s/:secret',
        { schema: { params: object({ secret: { type: 'string' } }) } },
        (req, reply) => controller.getConfigurations(req, reply),
    );
};
