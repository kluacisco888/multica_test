-- Undo 0015_countdowns.sql
-- 倒数日 reminders have no task: they go with the 倒数日 table.
DELETE FROM "reminder_deliveries" WHERE "task_id" IS NULL;
ALTER TABLE "reminder_deliveries" DROP CONSTRAINT IF EXISTS "reminder_deliveries_subject_check";
ALTER TABLE "reminder_deliveries" DROP CONSTRAINT IF EXISTS "reminder_deliveries_countdown_id_countdowns_id_fk";
DROP INDEX IF EXISTS "reminder_deliveries_countdown_idx";
ALTER TABLE "reminder_deliveries" DROP COLUMN IF EXISTS "countdown_id";
ALTER TABLE "reminder_deliveries" ALTER COLUMN "task_id" SET NOT NULL;
DROP TABLE IF EXISTS "countdowns";
