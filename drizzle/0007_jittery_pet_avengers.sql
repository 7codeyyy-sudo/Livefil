CREATE TABLE "ai_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"draft_type" varchar(24) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"sanitized_input" text NOT NULL,
	"result_json" jsonb,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"error_code" varchar(48),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_drafts_result_json_check" CHECK ("ai_drafts"."status" = 'failed' OR "ai_drafts"."result_json" IS NOT NULL),
	CONSTRAINT "ai_drafts_failed_error_code_check" CHECK ("ai_drafts"."status" <> 'failed' OR "ai_drafts"."error_code" IS NOT NULL),
	CONSTRAINT "ai_drafts_draft_type_check" CHECK ("ai_drafts"."draft_type" IN ('task_breakdown', 'schedule_suggestion', 'expense_parse', 'review_summary'))
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model" varchar(64) NOT NULL,
	"request_type" varchar(24) NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost_minor" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_drafts_user_status_created_idx" ON "ai_drafts" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ai_drafts_user_expires_idx" ON "ai_drafts" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "ai_drafts_user_input_hash_created_idx" ON "ai_drafts" USING btree ("user_id","input_hash","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");