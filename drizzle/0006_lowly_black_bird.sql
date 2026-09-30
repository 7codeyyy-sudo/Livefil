CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_id" uuid,
	"target_type" varchar(16) NOT NULL,
	"target_id" uuid,
	"channel" varchar(16) DEFAULT 'in_app' NOT NULL,
	"level" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"error_code" varchar(48),
	"next_retry_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_failed_error_code_check" CHECK ("notification_deliveries"."status" <> 'failed' OR "notification_deliveries"."error_code" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" varchar(16) NOT NULL,
	"target_id" uuid,
	"remind_at" time NOT NULL,
	"repeat_rule" varchar(16) DEFAULT 'none' NOT NULL,
	"allow_quiet_hours" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"level" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_rules_review_target_null_check" CHECK ("notification_rules"."target_type" <> 'review' OR "notification_rules"."target_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_rule_id_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_status_scheduled_idx" ON "notification_deliveries" USING btree ("user_id","status","scheduled_for");--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_scheduled_idx" ON "notification_deliveries" USING btree ("user_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_next_retry_idx" ON "notification_deliveries" USING btree ("user_id","next_retry_at") WHERE status = 'failed';--> statement-breakpoint
CREATE INDEX "notification_rules_user_target_idx" ON "notification_rules" USING btree ("user_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "notification_rules_user_enabled_remind_idx" ON "notification_rules" USING btree ("user_id","enabled","remind_at");