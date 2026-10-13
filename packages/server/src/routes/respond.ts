import type { FastifyReply } from 'fastify';
import { DEPTH_EXCEEDED_MESSAGE } from '@dida/shared';
import { isUniqueViolation } from '../db/errors.js';
import { sendError } from '../http-errors.js';

/* Error answers and the write wrapper shared by the resource routes. */

export const notFound = (reply: FastifyReply) => sendError(reply, 404, 'not_found', '资源不存在');
export const idTaken = (reply: FastifyReply) => sendError(reply, 409, 'conflict', '该 id 已被使用');
export const inboxProtected = (reply: FastifyReply, action: string) =>
  sendError(reply, 400, 'inbox_protected', `收件箱不能${action}`);
export const invalidFolder = (reply: FastifyReply) => sendError(reply, 400, 'invalid_folder', '文件夹不存在');
export const invalidTags = (reply: FastifyReply) => sendError(reply, 400, 'invalid_tags', '标签不存在');
export const invalidParentTag = (reply: FastifyReply, message: string) => sendError(reply, 400, 'invalid_parent', message);
export const tagNameTaken = (reply: FastifyReply) => sendError(reply, 409, 'tag_name_taken', '已有同名标签');
export const invalidList = (reply: FastifyReply) => sendError(reply, 400, 'invalid_list', '清单不存在');
export const invalidParent = (reply: FastifyReply) =>
  sendError(reply, 400, 'invalid_parent', '父任务不存在，或不能移到自己的子任务下面');
export const depthExceeded = (reply: FastifyReply) => sendError(reply, 400, 'depth_exceeded', DEPTH_EXCEEDED_MESSAGE);
export const notChecklist = (reply: FastifyReply) => sendError(reply, 400, 'not_checklist', '任务不是检查清单模式');
export const repeatNeedsDate = (reply: FastifyReply) => sendError(reply, 400, 'repeat_needs_date', '设置重复规则前需要先设置日期');
export const checklistMode = (reply: FastifyReply) =>
  sendError(reply, 400, 'checklist_mode', '检查清单模式的任务没有描述，请先切换为描述模式');

/** Thrown inside a transaction to roll it back and answer with an error. */
export class Rejection extends Error {
  constructor(readonly send: (reply: FastifyReply) => FastifyReply) {
    super('rejected');
  }
}

/** Run a write and answer with `ok(result)`; rejections and client-id collisions become error responses. */
export async function respond<T>(
  reply: FastifyReply,
  write: () => Promise<T>,
  ok: (result: T) => FastifyReply | object,
): Promise<FastifyReply | object> {
  let result: T;
  try {
    result = await write();
  } catch (error) {
    if (error instanceof Rejection) return error.send(reply);
    if (isUniqueViolation(error)) return idTaken(reply);
    throw error;
  }
  return ok(result);
}

