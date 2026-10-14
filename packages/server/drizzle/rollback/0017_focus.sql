-- Undo 0015_focus.sql
DROP TABLE IF EXISTS "focus_sessions";
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "pomodoro";
