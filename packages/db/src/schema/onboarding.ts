import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

// Repositories that users add, and the analysis of each one. See
// docs/specs/repo-onboarding-core.md.

export const REPOSITORY_STATUSES = ["queued", "running", "done", "failed"] as const;

export const FAILURE_REASONS = [
  "not_found",
  "too_large",
  "nothing_to_analyze",
  "github_rate_limit",
  "writer_failed",
  "timed_out",
  "unexpected",
] as const;

const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Canonical case, as GitHub returns it.
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    // Lowercase `owner/name`, so a user has each repository once whatever the
    // case of the URL.
    fullNameKey: text("full_name_key").notNull(),
    description: text("description"),
    defaultBranch: text("default_branch").notNull(),
    // The analyzed commit. Every walkthrough link points at it.
    commitSha: text("commit_sha").notNull(),
    // Text with a check rather than a Postgres enum, like
    // `subscriptions.status`.
    status: text("status", { enum: REPOSITORY_STATUSES }).default("queued").notNull(),
    failureReason: text("failure_reason", { enum: FAILURE_REASONS }),
    // The current pg-boss job, and the attempt (its `retryCount`) that set
    // `running`. Worker writes match both, so a stale run never overwrites a
    // retry of the same job.
    jobId: uuid("job_id").notNull(),
    jobAttempt: integer("job_attempt"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    // Coverage shown on the repository page.
    listedCount: integer("listed_count"),
    droppedCount: integer("dropped_count"),
    unscoredCount: integer("unscored_count"),
    localOnlyCount: integer("local_only_count"),
    // The walkthrough document: text and path references, never file contents.
    walkthrough: jsonb("walkthrough"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("repositories_userId_fullNameKey_idx").on(table.userId, table.fullNameKey),
    index("repositories_userId_createdAt_idx").on(table.userId, table.createdAt),
    index("repositories_jobId_idx").on(table.jobId),
    // For the maintenance job that fails analyses stuck in `queued` or
    // `running`.
    index("repositories_status_updatedAt_idx").on(table.status, table.updatedAt),
    check("repositories_status_check", sql`${table.status} in (${oneOf(REPOSITORY_STATUSES)})`),
    check(
      "repositories_failureReason_check",
      sql`${table.failureReason} in (${oneOf(FAILURE_REASONS)})`,
    ),
    // A failed analysis always has a reason, and only a failed one has one.
    check(
      "repositories_failureReason_status_check",
      sql`(${table.status} = 'failed') = (${table.failureReason} is not null)`,
    ),
  ],
);

// One row per add or retry request, accepted or not. The hourly request limit
// counts every row, and the daily analysis cap counts started rows. Rows do not
// reference `repositories`, so deleting a repository gives nothing back.
export const analysisRequests = pgTable(
  "analysis_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    started: boolean("started").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("analysis_requests_userId_createdAt_idx").on(table.userId, table.createdAt)],
);

export const repositoriesRelations = relations(repositories, ({ one }) => ({
  user: one(user, {
    fields: [repositories.userId],
    references: [user.id],
  }),
}));

export const analysisRequestsRelations = relations(analysisRequests, ({ one }) => ({
  user: one(user, {
    fields: [analysisRequests.userId],
    references: [user.id],
  }),
}));
