CREATE TABLE "analysis_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"started" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name_key" text NOT NULL,
	"description" text,
	"default_branch" text NOT NULL,
	"commit_sha" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"job_id" uuid NOT NULL,
	"job_attempt" integer,
	"started_at" timestamp,
	"finished_at" timestamp,
	"listed_count" integer,
	"dropped_count" integer,
	"unscored_count" integer,
	"local_only_count" integer,
	"walkthrough" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_status_check" CHECK ("repositories"."status" in ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "repositories_failureReason_check" CHECK ("repositories"."failure_reason" in ('not_found', 'too_large', 'nothing_to_analyze', 'github_rate_limit', 'writer_failed', 'timed_out', 'unexpected')),
	CONSTRAINT "repositories_failureReason_status_check" CHECK (("repositories"."status" = 'failed') = ("repositories"."failure_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "analysis_requests" ADD CONSTRAINT "analysis_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_requests_userId_createdAt_idx" ON "analysis_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_userId_fullNameKey_idx" ON "repositories" USING btree ("user_id","full_name_key");--> statement-breakpoint
CREATE INDEX "repositories_userId_createdAt_idx" ON "repositories" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "repositories_jobId_idx" ON "repositories" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "repositories_status_updatedAt_idx" ON "repositories" USING btree ("status","updated_at");