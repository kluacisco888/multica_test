CREATE TABLE "filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"rules" jsonb NOT NULL,
	"sort_order" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "exclude_from_smart_lists" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "hidden_smart_lists" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "view_options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "filters" ADD CONSTRAINT "filters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "filters_user_revision_idx" ON "filters" USING btree ("user_id","revision");