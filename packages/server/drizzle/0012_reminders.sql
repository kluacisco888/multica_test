CREATE TABLE "reminder_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"task_id" uuid NOT NULL,
	"source" text NOT NULL,
	"reminder_key" text,
	"fire_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"fired_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alert_dismissed_at" timestamp with time zone,
	CONSTRAINT "reminder_deliveries_status_check" CHECK ("reminder_deliveries"."status" IN ('scheduled', 'delivering', 'done', 'cancelled', 'missed')),
	CONSTRAINT "reminder_deliveries_source_check" CHECK ("reminder_deliveries"."source" IN ('rule', 'snooze'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminders" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminder_channel_ids" uuid[];--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "all_day_reminder_time" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminder_deliveries_user_revision_idx" ON "reminder_deliveries" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "reminder_deliveries_task_idx" ON "reminder_deliveries" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "reminder_deliveries_due_idx" ON "reminder_deliveries" USING btree ("next_attempt_at") WHERE "reminder_deliveries"."status" IN ('scheduled', 'delivering') AND "reminder_deliveries"."deleted_at" IS NULL;