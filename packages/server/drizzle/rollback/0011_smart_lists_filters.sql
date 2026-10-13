-- Undo 0011_smart_lists_filters.sql
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "view_options";
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "hidden_smart_lists";
ALTER TABLE "lists" DROP COLUMN IF EXISTS "exclude_from_smart_lists";
DROP TABLE IF EXISTS "filters";
