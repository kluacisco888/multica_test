CREATE TABLE "countdowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"date" date NOT NULL,
	"calendar" text NOT NULL,
	"repeat" text NOT NULL,
	"reminders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminder_channel_ids" jsonb,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"sort_order" text NOT NULL,
	CONSTRAINT "countdowns_calendar_check" CHECK ("countdowns"."calendar" IN ('solar', 'lunar')),
	CONSTRAINT "countdowns_repeat_check" CHECK ("countdowns"."repeat" IN ('none', 'yearly'))
);
--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD COLUMN "countdown_id" uuid;--> statement-breakpoint
ALTER TABLE "countdowns" ADD CONSTRAINT "countdowns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "countdowns_user_revision_idx" ON "countdowns" USING btree ("user_id","revision");--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_countdown_id_countdowns_id_fk" FOREIGN KEY ("countdown_id") REFERENCES "public"."countdowns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminder_deliveries_countdown_idx" ON "reminder_deliveries" USING btree ("countdown_id");--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_subject_check" CHECK (("reminder_deliveries"."task_id" IS NULL) <> ("reminder_deliveries"."countdown_id" IS NULL));