-- Undo 0006_subtasks_checklist.sql
DROP TABLE IF EXISTS "checklist_items";
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_kind_check";
DROP INDEX IF EXISTS "tasks_parent_idx";
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_parent_id_tasks_id_fk";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "parent_id";
