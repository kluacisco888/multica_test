import { z } from 'zod';
import {
  ATTACHMENT_MAX_BYTES,
  civilDateSchema,
  colorSchema,
  createChecklistItemRequestSchema,
  createCommentRequestSchema,
  createCountdownRequestSchema,
  createHabitRequestSchema,
  createTaskRequestSchema,
  createTagRequestSchema,
  emailConfigSchema,
  entityNameSchema,
  feishuConfigSchema,
  filterRulesSchema,
  iconSchema,
  putCheckinRequestSchema,
  sortKeySchema,
  timeZoneSchema,
  updateSettingsRequestSchema,
  uploadAttachmentQuerySchema,
  type BackupEntityType,
  type Reminder,
} from '@dida/shared';

/*
 * Business rules of a backup record's fields, beyond the column types: the
 * same zod schemas the API checks requests with (title and name lengths, time
 * zones, 重复规则, 提醒, 过滤器 rules, 设置, 通知渠道 config). A field missing
 * here only gets the column-type check (ids, timestamps, enums, booleans).
 * Values are stored as the schema outputs them (trimmed, de-duplicated).
 */

type Rec = Record<string, unknown>;
type FieldRules = Record<string, z.ZodType>;

/** Field schema of a request schema (`optional()` removed: only present fields are checked). */
function field(schema: z.ZodObject, key: string): z.ZodType {
  const s = schema.shape[key] as z.ZodType;
  return s instanceof z.ZodOptional ? (s.unwrap() as z.ZodType) : s;
}

const task = createTaskRequestSchema;
const settings = updateSettingsRequestSchema;
const civil = civilDateSchema;

const repeatBasisSchema = z.object({ prevDue: civil, completedOn: civil, today: civil, nextDue: civil }).strict().nullable();
const feishuCredentialsSchema = z.object({ webhookUrl: feishuConfigSchema.shape.webhookUrl, secret: z.string().max(512).nullable() }).strict();
const emailCredentialsSchema = emailConfigSchema.pick({ password: true }).strict();
const emailSettingsSchema = emailConfigSchema.omit({ password: true }).strict();
const habit = createHabitRequestSchema;
const countdown = createCountdownRequestSchema;

export const FIELD_RULES: Record<BackupEntityType, FieldRules> = {
  folder: { name: entityNameSchema, sortOrder: sortKeySchema },
  list: { name: entityNameSchema, color: colorSchema.nullable(), icon: iconSchema.nullable(), sortOrder: sortKeySchema },
  kanbanColumn: { name: entityNameSchema, sortOrder: sortKeySchema },
  tag: { name: field(createTagRequestSchema, 'name'), color: colorSchema.nullable(), sortOrder: sortKeySchema },
  notificationChannel: { name: entityNameSchema },
  task: {
    title: field(task, 'title'),
    description: field(task, 'description'),
    sortOrder: sortKeySchema,
    pinOrder: sortKeySchema.nullable(),
    timeZone: timeZoneSchema.nullable(),
    tagIds: field(task, 'tagIds'),
    repeat: field(task, 'repeat'),
    repeatIndex: z.number().int().min(1),
    repeatBasis: repeatBasisSchema,
    reminders: field(task, 'reminders'),
    reminderChannelIds: field(task, 'reminderChannelIds'),
  },
  checklistItem: { title: field(createChecklistItemRequestSchema, 'title'), sortOrder: sortKeySchema },
  attachment: {
    fileName: field(uploadAttachmentQuerySchema, 'name'),
    mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, 'MIME 类型不合法').max(255),
    size: z.number().int().min(0).max(ATTACHMENT_MAX_BYTES),
  },
  comment: { content: field(createCommentRequestSchema, 'content') },
  filter: { name: entityNameSchema, rules: filterRulesSchema, sortOrder: sortKeySchema },
  settings: {
    timeZone: field(settings, 'timeZone'),
    hiddenSmartLists: field(settings, 'hiddenSmartLists'),
    viewOptions: field(settings, 'viewOptions'),
    allDayReminderTime: field(settings, 'allDayReminderTime'),
    themeMode: field(settings, 'themeMode'),
    themeColor: field(settings, 'themeColor'),
    matrixQuadrants: field(settings, 'matrixQuadrants'),
    pomodoro: field(settings, 'pomodoro'),
  },
  countdown: {
    name: entityNameSchema,
    icon: field(countdown, 'icon'),
    date: civil,
    reminders: field(countdown, 'reminders'),
    reminderChannelIds: field(countdown, 'reminderChannelIds'),
    sortOrder: sortKeySchema,
  },
  focusSession: {
    plannedMs: z.number().int().min(0).nullable(),
    accumulatedMs: z.number().int().min(0),
  },
  habit: {
    name: field(habit, 'name'),
    color: colorSchema.nullable(),
    frequency: field(habit, 'frequency'),
    goal: field(habit, 'goal'),
    reminders: field(habit, 'reminders'),
    reminderChannelIds: field(habit, 'reminderChannelIds'),
    startDate: civil,
  },
  habitCheckin: { date: civil, count: putCheckinRequestSchema.shape.count },
};

/** Fields 回收站 cleanup empties on a tombstone (彻底删除): `''` is fine there. */
const PURGED_EMPTY = new Set(['title', 'description', 'content', 'fileName']);

const message = (key: string, error: z.ZodError) => `${key} ${error.issues[0]?.message ?? '不合法'}`;

/**
 * Check `record`'s fields against the API rules; returns the problems and the
 * record with each checked field in its stored (parsed) form.
 */
export function checkFields(type: BackupEntityType, record: Rec): { problems: string[]; record: Rec } {
  const out: Rec = { ...record };
  const problems: string[] = [];
  const tombstone = record.deletedAt != null;
  for (const [key, schema] of Object.entries(FIELD_RULES[type])) {
    if (!(key in record)) continue;
    if (tombstone && record[key] === '' && PURGED_EMPTY.has(key)) continue;
    const parsed = schema.safeParse(record[key]);
    if (parsed.success) out[key] = parsed.data;
    else problems.push(message(key, parsed.error));
  }
  if (problems.length > 0) return { problems, record: out };

  if (type === 'task') {
    const allDay = out.allDay as boolean | null | undefined;
    const fits = (r: Reminder) => allDay != null && (allDay ? r.type === 'day' : r.type === 'before');
    if (Array.isArray(out.reminders) && !(out.reminders as Reminder[]).every(fits)) problems.push('reminders 和任务的日期对不上');
  }
  if (type === 'notificationChannel') {
    const kind = out.type === 'email' ? 'email' : 'feishu';
    const settingsCheck = kind === 'email' ? emailSettingsSchema.safeParse(out.settings) : z.object({}).strict().safeParse(out.settings);
    if (!settingsCheck.success) problems.push(message('settings', settingsCheck.error));
    else out.settings = settingsCheck.data;
    if (out.credentials === null || out.credentials === undefined) {
      if (!tombstone) problems.push('credentials 缺失（导出时没能解密），不能导入这个通知渠道');
    } else {
      const creds = (kind === 'email' ? emailCredentialsSchema : feishuCredentialsSchema).safeParse(out.credentials);
      if (!creds.success) problems.push(message('credentials', creds.error));
      else out.credentials = creds.data;
    }
  }
  return { problems, record: out };
}
