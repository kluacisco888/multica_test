import { z } from 'zod';
import { passwordSchema, usernameSchema } from './auth.js';

/**
 * 后台 contract (spec 用户故事 9、11): a 管理员 adds 用户, disables and
 * enables them, and resets their password. Every `/api/admin/*` route answers
 * 403 to a signed-in user who is not a 管理员.
 */

export const adminUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

/** `GET /api/admin/users`: every 用户, oldest first. */
export const adminUsersResponseSchema = z.object({ users: z.array(adminUserSchema) });
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;

/** `POST /api/admin/users` */
export const createUserRequestSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    isAdmin: z.boolean().optional(),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/** `PATCH /api/admin/users/:id`: 停用 / 启用. */
export const updateUserRequestSchema = z.object({ disabled: z.boolean() }).strict();
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** `POST /api/admin/users/:id/password`: 重置密码; the user is logged out everywhere. */
export const resetPasswordRequestSchema = z.object({ password: passwordSchema }).strict();
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const CANNOT_DISABLE_SELF_MESSAGE = '不能停用自己的账户';
export const LAST_ADMIN_MESSAGE = '不能停用最后一个管理员';
