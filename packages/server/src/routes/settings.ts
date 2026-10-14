import type { FastifyInstance } from 'fastify';
import { liveQuadrants, updateSettingsRequestSchema, type Settings } from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { sendValidationError } from '../http-errors.js';
import { readSettings, writeSettings } from '../settings.js';
import { ruleRefs } from '../task-views.js';
import { checkRules } from './filters.js';
import { respond } from './respond.js';

/** API form: the 四象限 rules leave out deleted 清单 / 标签, like 过滤器 (the sync feed sends them as stored). */
async function settingsToApi(db: Executor, userId: string, settings: Settings): Promise<Settings> {
  const refs = await ruleRefs(db, userId);
  return { ...settings, matrixQuadrants: liveQuadrants(settings.matrixQuadrants, refs.liveLists, refs.liveTags) };
}

/** 设置 (spec 用户故事 26: the time zone; 72: the 四象限 rules). */
export function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async (request) => {
    const userId = sessionUser(request).id;
    return settingsToApi(app.db, userId, await readSettings(app.db, userId));
  });

  app.patch('/api/settings', async (request, reply) => {
    const body = updateSettingsRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { matrixQuadrants, ...rest } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          // 四象限 rules may only name the user's own 清单 and 标签 (400 invalid_list / invalid_tags).
          const refs = matrixQuadrants ? await ruleRefs(tx, userId) : null;
          const quadrants = matrixQuadrants && refs ? matrixQuadrants.map((q) => ({ name: q.name, rules: checkRules(q.rules, refs) })) : matrixQuadrants;
          const saved = await writeSettings(ops, tx, userId, { ...rest, ...(quadrants !== undefined ? { matrixQuadrants: quadrants } : {}) });
          return settingsToApi(tx, userId, saved);
        }),
      (settings) => settings,
    );
  });
}
