CREATE TYPE "public"."clip_context_type" AS ENUM('space', 'task', 'thread', 'project');--> statement-breakpoint
CREATE TYPE "public"."clip_mode" AS ENUM('async', 'live');--> statement-breakpoint
CREATE TYPE "public"."clip_status" AS ENUM('uploading', 'transcribing', 'summarizing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "agent_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_nudges" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"nudge_type" text NOT NULL,
	"message" text NOT NULL,
	"is_dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "burnout_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"alerted_to" text NOT NULL,
	"signals" jsonb,
	"confidence" real,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space_id" text,
	"message_id" text,
	"context_type" "clip_context_type" NOT NULL,
	"context_id" text NOT NULL,
	"mode" "clip_mode" DEFAULT 'async' NOT NULL,
	"created_by" text NOT NULL,
	"duration_s" integer,
	"file_key" text NOT NULL,
	"file_size" integer,
	"mime_type" text DEFAULT 'audio/webm' NOT NULL,
	"status" "clip_status" DEFAULT 'uploading' NOT NULL,
	"transcript" text,
	"segments" jsonb,
	"summary" jsonb,
	"participants" jsonb,
	"whisper_model" text,
	"error" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_references" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"context" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space_id" text NOT NULL,
	"message_id" text NOT NULL,
	"decision_text" text NOT NULL,
	"decided_by" text NOT NULL,
	"context" text,
	"tags" jsonb,
	"is_reversed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"error" text,
	"cron_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manager_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"team_pulse_frequency" text DEFAULT 'daily' NOT NULL,
	"oneone_prep_enabled" boolean DEFAULT true NOT NULL,
	"burnout_alerts_enabled" boolean DEFAULT true NOT NULL,
	"overload_threshold" integer DEFAULT 6 NOT NULL,
	"blocked_threshold_hours" integer DEFAULT 24 NOT NULL,
	"weekly_digest_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"brief_text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oneone_preps" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"report_id" text NOT NULL,
	"meeting_date" timestamp,
	"prep_content" jsonb,
	"status" text DEFAULT 'generated' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_expertise" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"question_answered_count" integer DEFAULT 0 NOT NULL,
	"mentioned_for_help_count" integer DEFAULT 0 NOT NULL,
	"tasks_completed_count" integer DEFAULT 0 NOT NULL,
	"expertise_score" real DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_influence" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"influence_type" text NOT NULL,
	"context" text,
	"score" real NOT NULL,
	"evidence_count" integer NOT NULL,
	"evidence_samples" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_a_id" text NOT NULL,
	"user_b_id" text NOT NULL,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"recency_weighted_score" real DEFAULT 0 NOT NULL,
	"dm_count" integer DEFAULT 0 NOT NULL,
	"shared_space_count" integer DEFAULT 0 NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"thread_co_participation" integer DEFAULT 0 NOT NULL,
	"last_interaction_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_patterns" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"pattern_type" text NOT NULL,
	"pattern_data" jsonb,
	"baseline_data" jsonb,
	"confidence" real,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_a_id" text NOT NULL,
	"user_b_id" text NOT NULL,
	"relationship_type" text NOT NULL,
	"strength" real,
	"direction" text,
	"evidence" jsonb,
	"first_detected_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standups" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"date" timestamp NOT NULL,
	"generated_by" text NOT NULL,
	"summary" text NOT NULL,
	"raw_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_health_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"snapshot_date" timestamp NOT NULL,
	"team_data" jsonb,
	"generated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parent_task_id" text;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_nudges" ADD CONSTRAINT "agent_nudges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_nudges" ADD CONSTRAINT "agent_nudges_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burnout_alerts" ADD CONSTRAINT "burnout_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burnout_alerts" ADD CONSTRAINT "burnout_alerts_alerted_to_users_id_fk" FOREIGN KEY ("alerted_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_references" ADD CONSTRAINT "cross_references_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_settings" ADD CONSTRAINT "manager_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_briefs" ADD CONSTRAINT "meeting_briefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_briefs" ADD CONSTRAINT "meeting_briefs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oneone_preps" ADD CONSTRAINT "oneone_preps_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oneone_preps" ADD CONSTRAINT "oneone_preps_report_id_users_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_expertise" ADD CONSTRAINT "people_expertise_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_influence" ADD CONSTRAINT "people_influence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_interactions" ADD CONSTRAINT "people_interactions_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_interactions" ADD CONSTRAINT "people_interactions_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_patterns" ADD CONSTRAINT "people_patterns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_relationships" ADD CONSTRAINT "people_relationships_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_relationships" ADD CONSTRAINT "people_relationships_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_upsert_unique" ON "agent_memory" USING btree ("user_id","conversation_id","key");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "burnout_alert_org_idx" ON "burnout_alerts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "burnout_alert_user_idx" ON "burnout_alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "clip_org_idx" ON "clips" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "clip_space_idx" ON "clips" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "clip_context_idx" ON "clips" USING btree ("context_type","context_id");--> statement-breakpoint
CREATE INDEX "clip_status_idx" ON "clips" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clip_created_by_idx" ON "clips" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "cross_ref_source_idx" ON "cross_references" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "cross_ref_target_idx" ON "cross_references" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "decisions_org_idx" ON "decisions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "decisions_space_idx" ON "decisions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "job_queue_poll_idx" ON "job_queue" USING btree ("status","queue","run_at");--> statement-breakpoint
CREATE INDEX "job_queue_cron_idx" ON "job_queue" USING btree ("cron_key");--> statement-breakpoint
CREATE UNIQUE INDEX "manager_settings_unique" ON "manager_settings" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "oneone_prep_org_idx" ON "oneone_preps" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "oneone_prep_manager_idx" ON "oneone_preps" USING btree ("manager_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_expertise_unique" ON "people_expertise" USING btree ("org_id","user_id","topic");--> statement-breakpoint
CREATE INDEX "people_expertise_org_idx" ON "people_expertise" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "people_influence_org_idx" ON "people_influence" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "people_influence_user_idx" ON "people_influence" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_interaction_unique" ON "people_interactions" USING btree ("org_id","user_a_id","user_b_id");--> statement-breakpoint
CREATE INDEX "people_interaction_org_idx" ON "people_interactions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_pattern_unique" ON "people_patterns" USING btree ("org_id","user_id","pattern_type");--> statement-breakpoint
CREATE INDEX "people_relationship_org_idx" ON "people_relationships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "team_health_org_idx" ON "team_health_snapshots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "task_parent_idx" ON "tasks" USING btree ("parent_task_id");