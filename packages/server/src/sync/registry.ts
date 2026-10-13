import type { SyncEntity } from './columns.js';

/**
 * Synced entity types served by `GET /api/changes`. Each feature task that
 * adds a table built with `syncColumns()` registers it here, e.g.
 *   { type: 'list', table: lists },
 */
export const syncEntities: readonly SyncEntity[] = [];
