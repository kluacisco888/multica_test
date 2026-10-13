-- Undo 0015_pinned_tasks.sql
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "pin_order";
