ALTER TABLE "tasks" ADD COLUMN "repeat" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeat_index" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeat_prev_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeat_basis" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeat_prev_id_tasks_id_fk" FOREIGN KEY ("repeat_prev_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_repeat_prev_idx" ON "tasks" USING btree ("repeat_prev_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeat_check" CHECK ("tasks"."repeat" IS NULL OR "tasks"."all_day" IS NOT NULL);