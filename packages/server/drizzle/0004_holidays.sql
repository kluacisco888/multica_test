CREATE TABLE "holiday_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "holiday_years_year_unique" UNIQUE("year")
);
