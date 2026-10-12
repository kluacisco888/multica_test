import type { FastifyReply } from 'fastify';
import type { ApiError } from '@dida/shared';
import type { ZodError } from 'zod';

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  issues?: unknown[],
): FastifyReply {
  const body: ApiError = { error: { code, message, ...(issues ? { issues } : {}) } };
  return reply.code(status).send(body);
}

export function sendValidationError(reply: FastifyReply, error: ZodError): FastifyReply {
  return sendError(reply, 400, 'invalid_request', '请求参数不合法', error.issues);
}
