ALTER TABLE "checklist_items" ADD COLUMN "trash_root_id" uuid;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "trash_root_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_trash_idx" ON "tasks" USING btree ("user_id","trash_root_id") WHERE "tasks"."trash_root_id" IS NOT NULL;