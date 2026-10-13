import {
  apiErrorSchema,
  folderSchema,
  listSchema,
  meResponseSchema,
  settingsSchema,
  sidebarResponseSchema,
  taskSchema,
  tasksResponseSchema,
  type ChangePasswordRequest,
  type CreateFolderRequest,
  type CreateListRequest,
  type CreateTaskRequest,
  type CurrentUser,
  type Folder,
  type LoginRequest,
  type Settings,
  type SidebarResponse,
  type Task,
  type TaskList,
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

export function errorMessage(error: unknown): string {
  if (error instanceof ApiCallError) return error.message;
  return '网络错误，请稍后重试';
}
