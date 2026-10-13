import { z } from 'zod';

/**
 * Account contract (spec 用户故事 4、7、8、10、11). There is deliberately no
 * registration endpoint: users are created from `.env` on first start or by the
 * server CLI.
 */

export const PASSWORD_MIN_LENGTH = 8;
/** Upper bound keeps hashing cost bounded for hostile input. */
export const PASSWORD_MAX_LENGTH = 256;

export const usernameSchema = z
  .string()
  .trim()
  .min(1, '账号不能为空')
  .max(64, '账号最多 64 个字符')
  .regex(/^\S+$/, '账号不能包含空白字符');

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${PASSWORD_MAX_LENGTH} 位`);

/** `POST /api/auth/login`. The password is not length-checked so old passwords still log in. */
export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `POST /api/auth/password` */
export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const currentUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  isAdmin: z.boolean(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

/** Body of `GET /api/auth/me` and of a successful login. */
export const meResponseSchema = z.object({ user: currentUserSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;
