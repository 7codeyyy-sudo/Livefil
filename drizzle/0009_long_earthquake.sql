CREATE TABLE "deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"purge_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "routine_steps_position_unique";--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deletion_requests_user_idx" ON "deletion_requests" USING btree ("user_id","purge_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_steps_position_unique" ON "routine_steps" USING btree ("routine_id","position") WHERE deleted_at is null;