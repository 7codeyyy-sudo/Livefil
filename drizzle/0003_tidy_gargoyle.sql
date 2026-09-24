CREATE TABLE "sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" uuid NOT NULL,
	"local_version" bigint,
	"server_version" bigint NOT NULL,
	"local_payload_json" jsonb,
	"server_payload_json" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_conflicts_user_status_idx" ON "sync_conflicts" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_conflicts_pending_unique" ON "sync_conflicts" USING btree ("user_id","entity_type","entity_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "actions_user_updated_idx" ON "actions" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "execution_logs_user_created_idx" ON "execution_logs" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "fixed_commitments_user_updated_idx" ON "fixed_commitments" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "goals_user_updated_idx" ON "goals" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "life_areas_user_updated_idx" ON "life_areas" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "routine_steps_user_updated_idx" ON "routine_steps" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "routines_user_updated_idx" ON "routines" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "schedule_blocks_user_updated_idx" ON "schedule_blocks" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "tasks_user_updated_idx" ON "tasks" USING btree ("user_id","updated_at","id");