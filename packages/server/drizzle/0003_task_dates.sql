CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"time_zone" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "all_day" boolean;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_settings_user_revision_idx" ON "user_settings" USING btree ("user_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "user_settings_one_per_user" ON "user_settings" USING btree ("user_id") WHERE "user_settings"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_dates_check" CHECK (CASE
        WHEN "tasks"."all_day" IS NULL THEN "tasks"."start_date" IS NULL AND "tasks"."due_date" IS NULL AND "tasks"."start_at" IS NULL AND "tasks"."due_at" IS NULL AND "tasks"."time_zone" IS NULL
        WHEN "tasks"."all_day" THEN "tasks"."due_date" IS NOT NULL AND "tasks"."start_at" IS NULL AND "tasks"."due_at" IS NULL AND "tasks"."time_zone" IS NULL AND ("tasks"."start_date" IS NULL OR "tasks"."start_date" <= "tasks"."due_date")
        ELSE "tasks"."due_at" IS NOT NULL AND "tasks"."time_zone" IS NOT NULL AND "tasks"."start_date" IS NULL AND "tasks"."due_date" IS NULL AND ("tasks"."start_at" IS NULL OR "tasks"."start_at" <= "tasks"."due_at")
      END);