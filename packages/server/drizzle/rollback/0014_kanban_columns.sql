-- Undo 0014_kanban_columns.sql
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_column_id_kanban_columns_id_fk";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "column_id";
DROP TABLE IF EXISTS "kanban_columns";
