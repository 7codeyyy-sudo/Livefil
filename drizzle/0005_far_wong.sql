CREATE TABLE "review_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"target_type" varchar(16) NOT NULL,
	"target_id" uuid NOT NULL,
	"action" varchar(24) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"review_type" varchar(8) NOT NULL,
	"period_key" varchar(10) NOT NULL,
	"answers" jsonb,
	"energy_level" varchar(8),
	"snapshot" jsonb,
	"snapshot_schema_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_adjustments" ADD CONSTRAINT "review_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_adjustments" ADD CONSTRAINT "review_adjustments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_adjustments_user_review_created_idx" ON "review_adjustments" USING btree ("user_id","review_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_user_type_period_unique" ON "reviews" USING btree ("user_id","review_type","period_key");--> statement-breakpoint
CREATE INDEX "reviews_user_updated_idx" ON "reviews" USING btree ("user_id","updated_at","id");