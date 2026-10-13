import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type { FilterRules } from '@dida/shared';
import { syncColumns, syncIndex } from '../../sync/columns.js';

/** 过滤器 (spec 用户故事 62): a named rule set over 清单, 标签, 日期 and 优先级 (see shared/filters.ts). */
export const filters = pgTable(
  'filters',
  {
    ...syncColumns(),
    name: text().notNull(),
    /** Validated with `filterRulesSchema` on write; read back through it too. */
    rules: jsonb().$type<FilterRules>().notNull(),
    /** Fractional key within the sidebar's 过滤器 section. */
    sortOrder: text().notNull(),
  },
  (t) => [syncIndex('filters', t)],
);
