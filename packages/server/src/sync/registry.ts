import { userSettings } from '../db/schema/settings.js';
import { notificationChannels } from '../db/schema/channels.js';
import { folders, lists, tasks } from '../db/schema/tasks.js';
import { channelToApi } from '../notify/notifier.js';
import type { SyncEntity } from './columns.js';

/**
 * Synced entity types served by `GET /api/changes`. Each feature task that
 * adds a table built with `syncColumns()` registers it here.
 */
export const syncEntities: readonly SyncEntity[] = [
  { type: 'folder', table: folders },
  { type: 'list', table: lists },
  { type: 'task', table: tasks },
  { type: 'settings', table: userSettings },
  // Credentials stay out of the sync feed: only the masked API form is sent.
  { type: 'notificationChannel', table: notificationChannels, serialize: channelToApi },
];
