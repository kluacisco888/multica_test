import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { noSessionResolver, type ResolveUser } from './auth.js';
import { systemClock, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import { sendError } from './http-errors.js';
import { changesRoutes } from './routes/changes.js';
import { healthRoutes } from './routes/health.js';
import type { SyncEntity } from './sync/columns.js';
import { syncEntities as registeredSyncEntities } from './sync/registry.js';
import { createSyncWriter, type SyncWriter } from './sync/sync.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  clock?: Clock;
  resolveUser?: ResolveUser;
  syncEntities?: readonly SyncEntity[];
  logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyInstance {
    clock: Clock;
    sync: SyncWriter;
  }
}

function trustHops(hops: number) {
  return (_address: string, hop: number) => hop < hops;
}

/** Build the Fastify app without listening; tests call this with injected deps. */
export async function buildApp(deps: AppDeps) {
  const { config, db } = deps;
  const clock = deps.clock ?? systemClock;
  const resolveUser = deps.resolveUser ?? noSessionResolver;

  const app = Fastify({
    logger: deps.logger ?? false,
    // A number means "trust this many hops"; Fastify's typings take it as a function.
    trustProxy:
      typeof config.trustProxy === 'number'
        ? trustHops(config.trustProxy)
        : config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  app.decorate('clock', clock);
  app.decorate('sync', createSyncWriter(db, clock));
  app.decorateRequest('user', null);
  app.decorate('authenticate', async function authenticate(request, reply) {
    const user = await resolveUser(request);
    if (!user) {
      await sendError(reply, 401, 'unauthorized', '未登录或会话已过期');
      return;
    }
    request.user = user;
  });

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return sendError(reply, 500, 'internal', '服务器内部错误');
    }
    return sendError(reply, status, 'bad_request', (error as Error).message);
  });

  healthRoutes(app, { db, config });
  changesRoutes(app, { db, syncEntities: deps.syncEntities ?? registeredSyncEntities });

  if (config.webDistDir) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDistDir) });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    // Client-side routes of the single-page app fall back to index.html.
    if (!isApi && config.webDistDir && request.method === 'GET') {
      return reply.sendFile('index.html');
    }
    return sendError(reply, 404, 'not_found', '资源不存在');
  });

  return app;
}
