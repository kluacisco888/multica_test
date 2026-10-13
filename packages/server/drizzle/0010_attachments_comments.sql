CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"task_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"task_id" uuid NOT NULL,
	"content" text NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_user_revision_idx" ON "attachments" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "attachments_task_idx" ON "attachments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "comments_user_revision_idx" ON "comments" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "comments_task_idx" ON "comments" USING btree ("task_id");