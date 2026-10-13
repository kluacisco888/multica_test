import { attachments, comments } from '../db/schema/attachments.js';
import { filters } from '../db/schema/filters.js';
import { tags } from '../db/schema/tags.js';
import { attachmentToApi } from '../routes/attachments.js';
import { commentToApi } from '../routes/comments.js';
import { userSettings } from '../db/schema/settings.js';
import { notificationChannels } from '../db/schema/channels.js';
import { channelToApi } from '../notify/notifier.js';
import { filterToApi } from '../routes/filters.js';
import { checklistItems, folders, lists, tasks } from '../db/schema/tasks.js';
import type { SyncEntity } from './columns.js';

/** Server-side 回收站 bookkeeping (see `trash.ts`), not part of the synced record. */
function withoutTrashColumns(row: Record<string, unknown>): object {
  const rest = { ...row };
  delete rest.trashRootId;
  delete rest.purgedAt;
  return rest;
}

/**
 * Synced entity types served by `GET /api/changes`. Each feature task that
 * adds a table built with `syncColumns()` registers it here.
 */
export const syncEntities: readonly SyncEntity[] = [
  { type: 'folder', table: folders },
  { type: 'list', table: lists },
  { type: 'task', table: tasks, serialize: withoutTrashColumns },
  { type: 'settings', table: userSettings },
  // Credentials stay out of the sync feed: only the masked API form is sent.
  { type: 'notificationChannel', table: notificationChannels, serialize: channelToApi },
  { type: 'checklistItem', table: checklistItems, serialize: withoutTrashColumns },
  { type: 'tag', table: tags },
  { type: 'attachment', table: attachments, serialize: attachmentToApi },
  { type: 'comment', table: comments, serialize: commentToApi },
  { type: 'filter', table: filters, serialize: filterToApi },
];
