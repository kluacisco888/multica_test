-- Undo 0013_theme.sql
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "theme_color";
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "theme_mode";
