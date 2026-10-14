CREATE TABLE "habit_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"habit_id" uuid NOT NULL,
	"date" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "habit_checkins_count_check" CHECK ("habit_checkins"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "habit_reminder_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"habit_id" uuid NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "habit_reminder_deliveries_status_check" CHECK ("habit_reminder_deliveries"."status" IN ('delivering', 'done'))
);
--> statement-breakpoint
CREATE TABLE "habits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"color" text,
	"frequency" jsonb NOT NULL,
	"goal" jsonb NOT NULL,
	"reminders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminder_channel_ids" uuid[],
	"start_date" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "habit_checkins" ADD CONSTRAINT "habit_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_checkins" ADD CONSTRAINT "habit_checkins_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_reminder_deliveries" ADD CONSTRAINT "habit_reminder_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_reminder_deliveries" ADD CONSTRAINT "habit_reminder_deliveries_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "habit_checkins_user_revision_idx" ON "habit_checkins" USING btree ("user_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_checkins_habit_date_unique" ON "habit_checkins" USING btree ("habit_id","date");--> statement-breakpoint
CREATE INDEX "habit_reminder_deliveries_user_revision_idx" ON "habit_reminder_deliveries" USING btree ("user_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_reminder_deliveries_habit_fire_unique" ON "habit_reminder_deliveries" USING btree ("habit_id","fire_at");--> statement-breakpoint
CREATE INDEX "habit_reminder_deliveries_due_idx" ON "habit_reminder_deliveries" USING btree ("next_attempt_at") WHERE "habit_reminder_deliveries"."status" = 'delivering';--> statement-breakpoint
CREATE INDEX "habits_user_revision_idx" ON "habits" USING btree ("user_id","revision");