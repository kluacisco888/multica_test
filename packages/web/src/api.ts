import {
  apiErrorSchema,
  meResponseSchema,
  type ChangePasswordRequest,
  type CurrentUser,
  type LoginRequest,
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

export function errorMessage(error: unknown): string {
  if (error instanceof ApiCallError) return error.message;
  return '网络错误，请稍后重试';
}
