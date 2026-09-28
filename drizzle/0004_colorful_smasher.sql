CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"sort_order" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"life_area_id" uuid,
	"goal_id" uuid,
	"action_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency_code" char(3) NOT NULL,
	"occurred_on" date NOT NULL,
	"payment_method" varchar(40),
	"note" text,
	"source" varchar(24) DEFAULT 'manual' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_life_area_id_life_areas_id_fk" FOREIGN KEY ("life_area_id") REFERENCES "public"."life_areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_categories_user_sort_idx" ON "expense_categories" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_user_active_name_unique" ON "expense_categories" USING btree ("user_id","name") WHERE is_archived = false;--> statement-breakpoint
CREATE INDEX "expenses_user_occurred_idx" ON "expenses" USING btree ("user_id","occurred_on");--> statement-breakpoint
CREATE INDEX "expenses_user_category_occurred_idx" ON "expenses" USING btree ("user_id","category_id","occurred_on");--> statement-breakpoint
CREATE INDEX "expenses_user_goal_idx" ON "expenses" USING btree ("user_id","goal_id");--> statement-breakpoint
CREATE INDEX "expenses_user_updated_idx" ON "expenses" USING btree ("user_id","updated_at","id");