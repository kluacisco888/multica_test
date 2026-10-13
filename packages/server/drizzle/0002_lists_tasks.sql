CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"sort_order" text NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"color" text,
	"icon" text,
	"folder_id" uuid,
	"sort_order" text NOT NULL,
	"is_inbox" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"list_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"sort_order" text NOT NULL,
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('open', 'completed', 'abandoned'))
);
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folders_user_revision_idx" ON "folders" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "lists_user_revision_idx" ON "lists" USING btree ("user_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "lists_one_inbox_per_user" ON "lists" USING btree ("user_id") WHERE "lists"."is_inbox" AND "lists"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_user_revision_idx" ON "tasks" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "tasks_user_list_idx" ON "tasks" USING btree ("user_id","list_id");