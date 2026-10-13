-- Undo 0009_repeat_tasks.sql
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_repeat_check";
DROP INDEX IF EXISTS "tasks_repeat_prev_idx";
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_repeat_prev_id_tasks_id_fk";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "repeat_basis";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "repeat_prev_id";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "repeat_index";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "repeat";
