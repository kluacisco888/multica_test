-- Undo 0007_priority_tags.sql
DROP INDEX IF EXISTS "tasks_tag_ids_idx";
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_priority_check";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "tag_ids";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "priority";
DROP TABLE IF EXISTS "tags";
