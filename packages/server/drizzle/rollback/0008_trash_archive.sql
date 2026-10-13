-- Undo 0008_trash_archive.sql
-- `abandoned` rows keep their status: the status check constraint has allowed it since 0002.
DROP INDEX IF EXISTS "tasks_trash_idx";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "purged_at";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "trash_root_id";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "abandoned_at";
ALTER TABLE "lists" DROP COLUMN IF EXISTS "archived_at";
ALTER TABLE "checklist_items" DROP COLUMN IF EXISTS "trash_root_id";
