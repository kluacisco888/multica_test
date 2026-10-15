-- Undo 0022_task_overdue_on.sql
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "overdue_on";
