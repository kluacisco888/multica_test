-- Undo 0001_auth.sql
DROP TABLE IF EXISTS "sessions";
ALTER TABLE "users" DROP COLUMN IF EXISTS "disabled_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_admin";
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash";
