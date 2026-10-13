-- Undo 0003_task_dates.sql
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_dates_check";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "time_zone";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "due_at";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "start_at";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "due_date";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "start_date";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "all_day";
DROP TABLE IF EXISTS "user_settings";
