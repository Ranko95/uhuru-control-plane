import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { HttpError, parseJson } from './protocol.ts';
import { digest } from './secrets.ts';
import { deliveryController } from './delivery/controller.ts';
import { accessController } from './access/controller.ts';
import * as access from './access/use-cases.ts';
import { nodeAdminController, nodeAgentController } from './nodes/controller.ts';
import * as nodes from './nodes/use-cases.ts';

export function buildApp(options: {
  pool: Pool; origin: string; adminUsername: string; adminPassword: string;
  tls: { key: Buffer; cert: Buffer };
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !options.adminUsername || options.adminUsername.includes(':') || options.adminPassword.length < 16) {
    throw new Error('invalid_settings');
  }
  const { pool } = options;
  const adminHash = digest(`Basic ${Buffer.from(`${options.adminUsername}:${options.adminPassword}`).toString('base64')}`);
  const app = Fastify({ https: options.tls, logger: false, bodyLimit: 2 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, parseJson(body as string)); } catch { done(new HttpError(400)); }
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (!(req.raw.socket as import('node:tls').TLSSocket).encrypted) throw new HttpError(400);
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as { statusCode?: number; code?: string };
    const accessStatus = error instanceof access.AccessError
      ? { not_found: 404, profile_limit: 409, revoked: 410, expired: 403 }[error.reason] : undefined;
    const nodeStatus = error instanceof nodes.NodeError
      ? { not_found: 404, unauthorized: 401, forbidden: 403, invalid_report: 400, state_conflict: 409 }[error.reason] : undefined;
    const status = accessStatus ?? nodeStatus
      ?? (e.code === '23505' ? 409 : e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 503);
    if (status === 503) reply.header('Retry-After', '15');
    if (status === 401 && !reply.hasHeader('WWW-Authenticate')) reply.header('WWW-Authenticate', 'Bearer');
    reply.code(status).send({ error: status === 503 ? 'temporarily_unavailable' : 'request_rejected' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.register(async admin => {
    admin.addHook('onRequest', async (req, reply) => {
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), adminHash)) {
        reply.header('WWW-Authenticate', 'Basic realm="Uhuru", charset="UTF-8"');
        throw new HttpError(401);
      }
    });
    admin.register(accessController, { pool, origin: origin.origin });
    admin.register(nodeAdminController, { pool });
  }, { prefix: '/admin' });

  app.register(nodeAgentController, { prefix: '/agent/v1', pool });
  app.register(deliveryController, { pool });
  return app;
}
