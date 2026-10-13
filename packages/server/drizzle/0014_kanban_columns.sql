CREATE TABLE "kanban_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"list_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "column_id" uuid;--> statement-breakpoint
ALTER TABLE "kanban_columns" ADD CONSTRAINT "kanban_columns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_columns" ADD CONSTRAINT "kanban_columns_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kanban_columns_user_revision_idx" ON "kanban_columns" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "kanban_columns_user_list_idx" ON "kanban_columns" USING btree ("user_id","list_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_kanban_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."kanban_columns"("id") ON DELETE no action ON UPDATE no action;