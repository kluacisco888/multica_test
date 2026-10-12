import { z } from 'zod';

/**
 * Sync contract from ADR-0004: `GET /api/changes?since=<revision>` returns every
 * record of the session user whose revision is greater than `since`, grouped by
 * entity type. Soft-deleted records are returned as tombstones.
 */

/** Query string of `GET /api/changes`. Omitting `since` means "from the beginning". */
export const changesQuerySchema = z.object({
  since: z
    .string()
    .regex(/^\d{1,15}$/, 'since 必须是非负整数修订号')
    .optional()
    .transform((value) => (value === undefined ? 0 : Number(value))),
});
export type ChangesQuery = z.output<typeof changesQuerySchema>;

export const tombstoneSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  deletedAt: z.iso.datetime(),
});
export type Tombstone = z.infer<typeof tombstoneSchema>;

export const entityChangesSchema = z.object({
  /** Live records, serialized like the entity's own API representation. */
  upserts: z.array(
    z.looseObject({ id: z.uuid(), revision: z.number().int().nonnegative() }),
  ),
  tombstones: z.array(tombstoneSchema),
});
export type EntityChanges = z.infer<typeof entityChangesSchema>;

export const changesResponseSchema = z.object({
  /** The user's current revision; pass it as `since` on the next call. */
  revision: z.number().int().nonnegative(),
  entities: z.record(z.string(), entityChangesSchema),
});
export type ChangesResponse = z.infer<typeof changesResponseSchema>;
