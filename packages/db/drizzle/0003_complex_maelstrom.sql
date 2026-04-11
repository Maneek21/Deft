CREATE TYPE "public"."entity_tag_type" AS ENUM('message', 'task', 'clip', 'daily_note');--> statement-breakpoint
CREATE TYPE "public"."mood" AS ENUM('great', 'good', 'okay', 'rough');--> statement-breakpoint
CREATE TABLE "daily_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"note_date" text NOT NULL,
	"content" text,
	"auto_items" jsonb,
	"summary" text,
	"mood" "mood",
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"entity_type" "entity_tag_type" NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_notes" ADD CONSTRAINT "daily_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_note_unique" ON "daily_notes" USING btree ("user_id","note_date");--> statement-breakpoint
CREATE INDEX "daily_note_org_idx" ON "daily_notes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "daily_note_user_idx" ON "daily_notes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_tag_unique" ON "entity_tags" USING btree ("tag_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "entity_tag_org_idx" ON "entity_tags" USING btree ("org_id","tag_id");--> statement-breakpoint
CREATE INDEX "entity_tag_entity_idx" ON "entity_tags" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_name_unique" ON "tags" USING btree ("org_id","name");