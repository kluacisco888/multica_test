import {
  apiErrorSchema,
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
  taskSchema,
  tasksResponseSchema,
  type ChangePasswordRequest,
  type ChecklistItem,
  type CreateChecklistItemRequest,
  type CreateFolderRequest,
  type CreateListRequest,
  type CreateTaskRequest,
  type CurrentUser,
  type Folder,
  type HolidayRefreshResponse,
  type HolidayStatus,
  type LoginRequest,
  type Settings,
  type SidebarResponse,
  type Task,
  type TaskList,
  type UpdateChecklistItemRequest,
  type UpdateFolderRequest,
  type UpdateListRequest,
  type UpdateSettingsRequest,
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
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
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

export async function fetchTasks(listId: string): Promise<Task[]> {
  const res = await call('GET', `/api/tasks?listId=${encodeURIComponent(listId)}`);
  return tasksResponseSchema.parse(await res.json()).tasks;
}

export async function createTask(request: CreateTaskRequest): Promise<Task> {
  return taskSchema.parse(await (await call('POST', '/api/tasks', request)).json());
}

export async function updateTask(id: string, patch: UpdateTaskRequest): Promise<Task> {
  return taskSchema.parse(await (await call('PATCH', `/api/tasks/${encodeURIComponent(id)}`, patch)).json());
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

export function errorMessage(error: unknown): string {
  if (error instanceof ApiCallError) return error.message;
  return '网络错误，请稍后重试';
}
