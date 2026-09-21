import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { HttpError } from '../protocol.ts';
import { secret } from '../secrets.ts';
import { getConfigurations } from './use-cases.ts';

export const deliveryController: FastifyPluginAsync<{ pool: Pool }> = async (
  app,
  { pool },
) => {
  app.get<{ Params: { secret: string } }>('/s/:secret', async (req, reply) => {
    // Check the wire encoding, including URL escaping, before a database lookup.
    if (req.raw.url !== '/s/' + req.params.secret) throw new HttpError(404);
    const raw = secret(req.params.secret);
    if (!raw) throw new HttpError(404);
    const result = await getConfigurations(pool, raw);
    return reply.type('text/plain; charset=utf-8').send(result);
  });
};
