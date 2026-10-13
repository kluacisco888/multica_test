-- Undo 0012_reminders.sql
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "all_day_reminder_time";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "reminder_channel_ids";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "reminders";
DROP TABLE IF EXISTS "reminder_deliveries";
