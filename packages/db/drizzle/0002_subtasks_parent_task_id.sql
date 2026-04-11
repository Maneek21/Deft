ALTER TABLE "tasks" ADD COLUMN "parent_task_id" text;--> statement-breakpoint
CREATE INDEX "task_parent_idx" ON "tasks" USING btree ("parent_task_id");
