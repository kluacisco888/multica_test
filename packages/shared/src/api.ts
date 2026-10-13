import { z } from 'zod';

/** Error body returned by every API endpoint on failure. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'unavailable']),
  publicUrl: z.string(),
  /** How the app sees the current request after applying trusted X-Forwarded-* headers. */
  request: z.object({
    protocol: z.string(),
    host: z.string(),
    ip: z.string(),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
