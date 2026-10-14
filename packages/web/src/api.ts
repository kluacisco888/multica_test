import {
  batchResponseSchema,
  moveTaskResponseSchema,
  type BatchAction,
  type BatchRequest,
  type MoveTaskRequest,
  currentFocusResponseSchema,
  focusRecordsResponseSchema,
  focusStatsSchema,
  type CurrentFocusResponse,
  type FocusRecord,
  type FocusStats,
  type FocusStatUnit,
  type StartFocusRequest,
  habitSchema,
  habitsResponseSchema,
  type CreateHabitRequest,
  type Habit,
  type UpdateHabitRequest,
  adminUserSchema,
  calendarDaysResponseSchema,
  type CalendarDay,
  type CalendarRange,
  adminUsersResponseSchema,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TOO_LARGE_MESSAGE,
  attachmentSchema,
  attachmentsResponseSchema,
  commentSchema,
  commentsResponseSchema,
  countdownSchema,
  countdownsResponseSchema,
  type Countdown,
  type CreateCountdownRequest,
  type UpdateCountdownRequest,
  type Attachment,
  type Comment,
  filterSchema,
  filtersResponseSchema,
  kanbanColumnSchema,
  kanbanColumnsResponseSchema,
  type CreateKanbanColumnRequest,
  type DeleteKanbanColumnQuery,
  type KanbanColumn,
  type UpdateKanbanColumnRequest,
  searchResponseSchema,
  smartListCountsResponseSchema,
  type CreateFilterRequest,
  type Filter,
  type SearchResponse,
  type UpdateFilterRequest,
  apiErrorSchema,
  reminderAlertsResponseSchema,
  reminderFailuresResponseSchema,
  type ReminderAlert,
  type ReminderFailure,
  type AdminUser,
  type CreateUserRequest,
  channelsResponseSchema,
  notificationChannelSchema,
  type CreateChannelRequest,
  type NotificationChannel,
  type UpdateChannelRequest,
  checklistItemSchema,
  checklistItemsResponseSchema,
  folderSchema,
  holidayRefreshResponseSchema,
  holidayStatusSchema,
  listSchema,
  meResponseSchema,
  settingsSchema,
  sidebarResponseSchema,
  tagSchema,
  tagsResponseSchema,
  taskSchema,
  tasksResponseSchema,
  trashResponseSchema,
  type ChangePasswordRequest,
  type ChecklistItem,
  type CreateChecklistItemRequest,
  type CreateFolderRequest,
  type CreateListRequest,
  type CreateTagRequest,
  type CreateTaskRequest,
  type CurrentUser,
  type Folder,
  type HolidayRefreshResponse,
  type HolidayStatus,
  type LoginRequest,
  type Settings,
  type SidebarResponse,
  type Tag,
  type TasksQuery,
  type Task,
  type TaskList,
  type TrashedTask,
  type UpdateChecklistItemRequest,
  type UpdateFolderRequest,
  type UpdateListRequest,
  type UpdateSettingsRequest,
  type UpdateTagRequest,
  type UpdateTaskRequest,
} from '@dida/shared';

/** A failed API call with the server's error code and Chinese message. */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call(method: string, url: string, body?: unknown): Promise<Response> {
  return check(
    await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
  throw parsed.success
    ? new ApiCallError(res.status, parsed.data.error.code, parsed.data.error.message)
    : new ApiCallError(res.status, 'unknown', `请求失败（${res.status}）`);
}

/** The logged-in user, or null when there is no valid session. */
export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const res = await call('GET', '/api/auth/me');
    return meResponseSchema.parse(await res.json()).user;
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) return null;
    throw error;
  }
}

export async function login(request: LoginRequest): Promise<CurrentUser> {
  const res = await call('POST', '/api/auth/login', request);
  return meResponseSchema.parse(await res.json()).user;
}

export async function logout(): Promise<void> {
  await call('POST', '/api/auth/logout');
}

export async function changePassword(request: ChangePasswordRequest): Promise<void> {
  await call('POST', '/api/auth/password', request);
}

export async function fetchSidebar(): Promise<SidebarResponse> {
  return sidebarResponseSchema.parse(await (await call('GET', '/api/lists')).json());
}

export async function createList(request: CreateListRequest): Promise<TaskList> {
  return listSchema.parse(await (await call('POST', '/api/lists', request)).json());
}

export async function updateList(id: string, patch: UpdateListRequest): Promise<TaskList> {
  return listSchema.parse(await (await call('PATCH', `/api/lists/${encodeURIComponent(id)}`, patch)).json());
}

export async function deleteList(id: string): Promise<void> {
  await call('DELETE', `/api/lists/${encodeURIComponent(id)}`);
}

export async function createFolder(request: CreateFolderRequest): Promise<Folder> {
  return folderSchema.parse(await (await call('POST', '/api/folders', request)).json());
}

export async function updateFolder(id: string, patch: UpdateFolderRequest): Promise<Folder> {
  return folderSchema.parse(await (await call('PATCH', `/api/folders/${encodeURIComponent(id)}`, patch)).json());
}

export async function deleteFolder(id: string): Promise<void> {
  await call('DELETE', `/api/folders/${encodeURIComponent(id)}`);
}

/** Tasks of one 清单, 标签 (a parent 标签 includes its children's tasks), 智能清单 or 过滤器. */
export async function fetchTasks(query: TasksQuery): Promise<Task[]> {
  const res = await call('GET', `/api/tasks?${new URLSearchParams(query as Record<string, string>).toString()}`);
  return tasksResponseSchema.parse(await res.json()).tasks;
}

export async function createTask(request: CreateTaskRequest): Promise<Task> {
  return taskSchema.parse(await (await call('POST', '/api/tasks', request)).json());
}

export async function updateTask(id: string, patch: UpdateTaskRequest): Promise<Task> {
  return taskSchema.parse(await (await call('PATCH', `/api/tasks/${encodeURIComponent(id)}`, patch)).json());
}

/** 拖拽排序: right after `afterId` (null: first) in the task's group; returns every task whose key changed. */
export async function moveTask(id: string, afterId: string | null): Promise<Task[]> {
  const res = await call('POST', `/api/tasks/${encodeURIComponent(id)}/move`, { afterId } satisfies MoveTaskRequest);
  return moveTaskResponseSchema.parse(await res.json()).tasks;
}

/** 批量操作 on the selected tasks; returns them as they are now (deleted ones left out). */
export async function batchTasks(ids: string[], action: BatchAction): Promise<Task[]> {
  const res = await call('POST', '/api/tasks/batch', { ids, action } satisfies BatchRequest);
  return batchResponseSchema.parse(await res.json()).tasks;
}

/** 删除: the task (with its 子任务) moves to the 回收站. */
export async function deleteTask(id: string): Promise<void> {
  await call('DELETE', `/api/tasks/${encodeURIComponent(id)}`);
}

export async function fetchTrash(): Promise<TrashedTask[]> {
  return trashResponseSchema.parse(await (await call('GET', '/api/trash')).json()).tasks;
}

export async function restoreTask(id: string): Promise<Task> {
  return taskSchema.parse(await (await call('POST', `/api/trash/${encodeURIComponent(id)}/restore`)).json());
}

/** 彻底删除 one task from the 回收站. */
export async function purgeTask(id: string): Promise<void> {
  await call('DELETE', `/api/trash/${encodeURIComponent(id)}`);
}

export async function emptyTrash(): Promise<void> {
  await call('DELETE', '/api/trash');
}

export async function fetchSettings(): Promise<Settings> {
  return settingsSchema.parse(await (await call('GET', '/api/settings')).json());
}

export async function updateSettings(patch: UpdateSettingsRequest): Promise<Settings> {
  return settingsSchema.parse(await (await call('PATCH', '/api/settings', patch)).json());
}

export async function fetchHolidayStatus(): Promise<HolidayStatus> {
  return holidayStatusSchema.parse(await (await call('GET', '/api/holidays/status')).json());
}

/** 日历: 农历, 传统节日 and 休 / 班 of each day `from`–`to`. */
export async function fetchCalendarDays({ from, to }: CalendarRange): Promise<CalendarDay[]> {
  const res = await call('GET', `/api/calendar/days?${new URLSearchParams({ from, to }).toString()}`);
  return calendarDaysResponseSchema.parse(await res.json()).days;
}

export async function refreshHolidays(): Promise<HolidayRefreshResponse> {
  return holidayRefreshResponseSchema.parse(await (await call('POST', '/api/holidays/refresh')).json());
}

export async function fetchChannels(): Promise<NotificationChannel[]> {
  return channelsResponseSchema.parse(await (await call('GET', '/api/notification-channels')).json()).channels;
}

export async function createChannel(request: CreateChannelRequest): Promise<NotificationChannel> {
  return notificationChannelSchema.parse(await (await call('POST', '/api/notification-channels', request)).json());
}

export async function updateChannel(id: string, patch: UpdateChannelRequest): Promise<NotificationChannel> {
  const res = await call('PATCH', `/api/notification-channels/${encodeURIComponent(id)}`, patch);
  return notificationChannelSchema.parse(await res.json());
}

export async function deleteChannel(id: string): Promise<void> {
  await call('DELETE', `/api/notification-channels/${encodeURIComponent(id)}`);
}

/** 发送测试消息; rejects with the server's concrete reason when delivery fails. */
export async function testChannel(id: string): Promise<void> {
  await call('POST', `/api/notification-channels/${encodeURIComponent(id)}/test`);
}

export async function fetchChecklistItems(taskId: string): Promise<ChecklistItem[]> {
  const res = await call('GET', `/api/tasks/${encodeURIComponent(taskId)}/checklist-items`);
  return checklistItemsResponseSchema.parse(await res.json()).items;
}

export async function createChecklistItem(taskId: string, request: CreateChecklistItemRequest): Promise<ChecklistItem> {
  const res = await call('POST', `/api/tasks/${encodeURIComponent(taskId)}/checklist-items`, request);
  return checklistItemSchema.parse(await res.json());
}

export async function updateChecklistItem(id: string, patch: UpdateChecklistItemRequest): Promise<ChecklistItem> {
  return checklistItemSchema.parse(await (await call('PATCH', `/api/checklist-items/${encodeURIComponent(id)}`, patch)).json());
}

export async function deleteChecklistItem(id: string): Promise<void> {
  await call('DELETE', `/api/checklist-items/${encodeURIComponent(id)}`);
}

export async function fetchTags(): Promise<Tag[]> {
  return tagsResponseSchema.parse(await (await call('GET', '/api/tags')).json()).tags;
}

export async function createTag(request: CreateTagRequest): Promise<Tag> {
  return tagSchema.parse(await (await call('POST', '/api/tags', request)).json());
}

export async function updateTag(id: string, patch: UpdateTagRequest): Promise<Tag> {
  return tagSchema.parse(await (await call('PATCH', `/api/tags/${encodeURIComponent(id)}`, patch)).json());
}

export async function deleteTag(id: string): Promise<void> {
  await call('DELETE', `/api/tags/${encodeURIComponent(id)}`);
}

export async function fetchAttachments(taskId: string): Promise<Attachment[]> {
  const res = await call('GET', `/api/tasks/${encodeURIComponent(taskId)}/attachments`);
  return attachmentsResponseSchema.parse(await res.json()).attachments;
}

/** Upload one file as the raw request body; files over 50MB are refused before sending. */
export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  if (file.size > ATTACHMENT_MAX_BYTES) throw new ApiCallError(413, 'file_too_large', ATTACHMENT_TOO_LARGE_MESSAGE);
  const query = new URLSearchParams({ name: file.name });
  const res = await check(
    await fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments?${query.toString()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    }),
  );
  return attachmentSchema.parse(await res.json());
}

export async function deleteAttachment(id: string): Promise<void> {
  await call('DELETE', `/api/attachments/${encodeURIComponent(id)}`);
}

/** Same-origin URL of the file; the session cookie authorises it. */
export function attachmentUrl(id: string, download = false): string {
  return `/api/attachments/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`;
}

export async function fetchComments(taskId: string): Promise<Comment[]> {
  const res = await call('GET', `/api/tasks/${encodeURIComponent(taskId)}/comments`);
  return commentsResponseSchema.parse(await res.json()).comments;
}

export async function createComment(taskId: string, content: string): Promise<Comment> {
  return commentSchema.parse(await (await call('POST', `/api/tasks/${encodeURIComponent(taskId)}/comments`, { content })).json());
}

export async function updateComment(id: string, content: string): Promise<Comment> {
  return commentSchema.parse(await (await call('PATCH', `/api/comments/${encodeURIComponent(id)}`, { content })).json());
}

export async function deleteComment(id: string): Promise<void> {
  await call('DELETE', `/api/comments/${encodeURIComponent(id)}`);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiCallError) return error.message;
  return '网络错误，请稍后重试';
}

/* ---- 后台 (管理员 only; everyone else gets 403) ---- */

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  return adminUsersResponseSchema.parse(await (await call('GET', '/api/admin/users')).json()).users;
}

export async function createAdminUser(request: CreateUserRequest): Promise<AdminUser> {
  return adminUserSchema.parse(await (await call('POST', '/api/admin/users', request)).json());
}

/** 停用 / 启用 a 用户. */
export async function setUserDisabled(id: string, disabled: boolean): Promise<AdminUser> {
  return adminUserSchema.parse(await (await call('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, { disabled })).json());
}

export async function resetUserPassword(id: string, password: string): Promise<void> {
  await call('POST', `/api/admin/users/${encodeURIComponent(id)}/password`, { password });
}

/** Open-task counts of 今天 / 明天 / 最近7天 for the sidebar. */
export async function fetchSmartListCounts(): Promise<Record<string, number>> {
  return smartListCountsResponseSchema.parse(await (await call('GET', '/api/smart-lists')).json()).counts;
}

export async function fetchFilters(): Promise<Filter[]> {
  return filtersResponseSchema.parse(await (await call('GET', '/api/filters')).json()).filters;
}

export async function createFilter(request: CreateFilterRequest): Promise<Filter> {
  return filterSchema.parse(await (await call('POST', '/api/filters', request)).json());
}

export async function updateFilter(id: string, patch: UpdateFilterRequest): Promise<Filter> {
  return filterSchema.parse(await (await call('PATCH', `/api/filters/${encodeURIComponent(id)}`, patch)).json());
}

export async function deleteFilter(id: string): Promise<void> {
  await call('DELETE', `/api/filters/${encodeURIComponent(id)}`);
}

/** 全局搜索 over title, 描述, 检查项 (and 评论 once they exist). */
export async function searchTasks(q: string): Promise<SearchResponse> {
  return searchResponseSchema.parse(await (await call('GET', `/api/search?${new URLSearchParams({ q }).toString()}`)).json());
}

/* ---- 提醒 (spec 用户故事 82、83) ---- */

/** 应用内提醒: reminders that fired in the last hour and were not dismissed. */
export async function fetchReminderAlerts(): Promise<ReminderAlert[]> {
  return reminderAlertsResponseSchema.parse(await (await call('GET', '/api/reminders/alerts')).json()).alerts;
}

export async function dismissReminderAlert(id: string): Promise<void> {
  await call('POST', `/api/reminders/alerts/${encodeURIComponent(id)}/dismiss`);
}

/** 稍后提醒: remind again in `minutes`. */
export async function snoozeReminderAlert(id: string, minutes: number): Promise<void> {
  await call('POST', `/api/reminders/alerts/${encodeURIComponent(id)}/snooze`, { minutes });
}

/** Deliveries that still failed after their retries. */
export async function fetchReminderFailures(): Promise<ReminderFailure[]> {
  return reminderFailuresResponseSchema.parse(await (await call('GET', '/api/reminders/failures')).json()).failures;
}

/** 看板分栏 of a 清单, left to right. */
export async function fetchKanbanColumns(listId: string): Promise<KanbanColumn[]> {
  const res = await call('GET', `/api/kanban-columns?${new URLSearchParams({ listId }).toString()}`);
  return kanbanColumnsResponseSchema.parse(await res.json()).columns;
}

export async function createKanbanColumn(request: CreateKanbanColumnRequest): Promise<KanbanColumn> {
  return kanbanColumnSchema.parse(await (await call('POST', '/api/kanban-columns', request)).json());
}

export async function updateKanbanColumn(id: string, patch: UpdateKanbanColumnRequest): Promise<KanbanColumn> {
  return kanbanColumnSchema.parse(await (await call('PATCH', `/api/kanban-columns/${encodeURIComponent(id)}`, patch)).json());
}

/** 删除分组: its tasks go to the 回收站, or move to another 分栏 / 未分组. */
export async function deleteKanbanColumn(id: string, query: DeleteKanbanColumnQuery): Promise<void> {
  const params = new URLSearchParams({ tasks: query.tasks ?? 'delete', ...(query.moveTo ? { moveTo: query.moveTo } : {}) });
  await call('DELETE', `/api/kanban-columns/${encodeURIComponent(id)}?${params.toString()}`);
}

/* ---- 番茄专注 (spec 用户故事 86–92) ---- */

/** The running or paused session (settled at the server's now), with that now. */
export async function fetchCurrentFocus(): Promise<CurrentFocusResponse> {
  return currentFocusResponseSchema.parse(await (await call('GET', '/api/focus/current')).json());
}

export async function startFocus(request: StartFocusRequest): Promise<CurrentFocusResponse> {
  return currentFocusResponseSchema.parse(await (await call('POST', '/api/focus/start', request)).json());
}

/** 暂停 / 继续 / 放弃 / 结束 the current session. */
export async function focusAction(action: 'pause' | 'resume' | 'abandon' | 'finish'): Promise<CurrentFocusResponse> {
  return currentFocusResponseSchema.parse(await (await call('POST', `/api/focus/current/${action}`)).json());
}

/** Link the current session to a 任务, or unlink it. */
export async function linkFocusTask(taskId: string | null): Promise<CurrentFocusResponse> {
  return currentFocusResponseSchema.parse(await (await call('PATCH', '/api/focus/current', { taskId })).json());
}

export async function fetchFocusRecords(): Promise<FocusRecord[]> {
  return focusRecordsResponseSchema.parse(await (await call('GET', '/api/focus/records')).json()).records;
}

export async function fetchFocusStats(unit: FocusStatUnit, date: string): Promise<FocusStats> {
  return focusStatsSchema.parse(await (await call('GET', `/api/focus/stats?${new URLSearchParams({ unit, date }).toString()}`)).json());
}

/* ---- 倒数日 (spec 用户故事 99–101) ---- */

/** 记录中 (default) or 已归档 倒数日, 置顶 first. */
export async function fetchCountdowns(archived = false): Promise<Countdown[]> {
  const res = await call('GET', `/api/countdowns${archived ? '?archived=true' : ''}`);
  return countdownsResponseSchema.parse(await res.json()).countdowns;
}

export async function createCountdown(request: CreateCountdownRequest): Promise<Countdown> {
  return countdownSchema.parse(await (await call('POST', '/api/countdowns', request)).json());
}

export async function updateCountdown(id: string, patch: UpdateCountdownRequest): Promise<Countdown> {
  return countdownSchema.parse(await (await call('PATCH', `/api/countdowns/${encodeURIComponent(id)}`, patch)).json());
}

export async function deleteCountdown(id: string): Promise<void> {
  await call('DELETE', `/api/countdowns/${encodeURIComponent(id)}`);
}

/* ---- 习惯打卡 (spec 用户故事 93–98) ---- */

export async function fetchHabits(archived = false): Promise<Habit[]> {
  return habitsResponseSchema.parse(await (await call('GET', `/api/habits${archived ? '?archived=true' : ''}`)).json()).habits;
}

export async function createHabit(request: CreateHabitRequest): Promise<Habit> {
  return habitSchema.parse(await (await call('POST', '/api/habits', request)).json());
}

export async function updateHabit(id: string, request: UpdateHabitRequest): Promise<Habit> {
  return habitSchema.parse(await (await call('PATCH', `/api/habits/${encodeURIComponent(id)}`, request)).json());
}

export async function deleteHabit(id: string): Promise<void> {
  await call('DELETE', `/api/habits/${encodeURIComponent(id)}`);
}

/** 打卡 / 补打卡 with the day's amount. */
export async function checkInHabit(id: string, date: string, count: number): Promise<Habit> {
  return habitSchema.parse(await (await call('PUT', `/api/habits/${encodeURIComponent(id)}/checkins/${date}`, { count })).json());
}

/** 撤销打卡 of a day. */
export async function undoCheckIn(id: string, date: string): Promise<Habit> {
  return habitSchema.parse(await (await call('DELETE', `/api/habits/${encodeURIComponent(id)}/checkins/${date}`)).json());
}
