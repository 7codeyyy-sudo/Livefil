CREATE TABLE "life_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"color_key" varchar(32) NOT NULL,
	"sort_order" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320),
	"display_name" varchar(80),
	"mode" varchar(16) NOT NULL,
	"locale" varchar(16) DEFAULT 'zh-CN' NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"currency_code" char(3) DEFAULT 'CNY' NOT NULL,
	"week_starts_on" smallint DEFAULT 1 NOT NULL,
	"reminder_enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" time,
	"quiet_hours_end" time,
	"default_task_duration_minutes" integer,
	"default_buffer_minutes" integer,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"ai_data_consent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "life_areas" ADD CONSTRAINT "life_areas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "life_areas_user_sort_idx" ON "life_areas" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "life_areas_user_active_name_unique" ON "life_areas" USING btree ("user_id","name") WHERE is_archived = false;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_mode_idx" ON "users" USING btree ("mode");--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_local_unique" ON "users" USING btree ("mode") WHERE mode = 'local';