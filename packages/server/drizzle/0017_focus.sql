CREATE TABLE "focus_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"mode" text NOT NULL,
	"phase" text NOT NULL,
	"status" text NOT NULL,
	"task_id" uuid,
	"planned_ms" bigint,
	"accumulated_ms" bigint DEFAULT 0 NOT NULL,
	"resumed_at" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "focus_sessions_mode_check" CHECK ("focus_sessions"."mode" IN ('pomodoro', 'stopwatch')),
	CONSTRAINT "focus_sessions_phase_check" CHECK ("focus_sessions"."phase" IN ('focus', 'shortBreak', 'longBreak')),
	CONSTRAINT "focus_sessions_status_check" CHECK ("focus_sessions"."status" IN ('running', 'paused', 'completed', 'abandoned'))
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "pomodoro" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "focus_sessions_user_revision_idx" ON "focus_sessions" USING btree ("user_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_sessions_one_active_per_user" ON "focus_sessions" USING btree ("user_id") WHERE "focus_sessions"."status" IN ('running', 'paused') AND "focus_sessions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "focus_sessions_user_started_idx" ON "focus_sessions" USING btree ("user_id","started_at");