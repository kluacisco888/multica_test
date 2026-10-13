import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@dida/shared';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';

export function healthRoutes(app: FastifyInstance, deps: { db: Db; config: AppConfig }) {
  app.get('/api/health', { config: { public: true } }, async (request, reply) => {
    let dbOk = true;
    try {
      await deps.db.execute(sql`select 1`);
    } catch (error) {
      request.log.error({ err: error }, 'health check: database unavailable');
      dbOk = false;
    }
    const body: HealthResponse = {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'unavailable',
      publicUrl: deps.config.publicUrl,
      request: { protocol: request.protocol, host: request.host, ip: request.ip },
    };
    return reply.code(dbOk ? 200 : 503).send(body);
  });
}
