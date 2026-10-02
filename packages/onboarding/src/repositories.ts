import { randomUUID } from "node:crypto";

import { db as defaultDb, schema, sql, type Database } from "@startup/db";
import { isEmailConfigured } from "@startup/email";
import {
  createGitHubClient,
  GitHubEmptyRepositoryError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubUnavailableError,
  parseRepositoryUrl,
  type GitHubClient,
  type Repository,
} from "@startup/github";
import { getJobQueue, inTransaction, JobQueueUnavailableError, QUEUES, type JobQueue } from "@startup/jobs";

import { RepositoryNotFoundError, RepositoryRequestError } from "./errors";
import { DAILY_ANALYSIS_LIMIT, HOURLY_REQUEST_LIMIT, REPOSITORY_LIMIT } from "./limits";
import { sendAnalysis } from "./queue";

const { analysisRequests, repositories } = schema;

export type RepositoryStatus = (typeof schema.REPOSITORY_STATUSES)[number];
export type FailureReason = (typeof schema.FAILURE_REASONS)[number];

/** The signed-in user, as the session gives it. */
export interface OnboardingUser {
  readonly id: string;
  readonly emailVerified: boolean;
}

export interface RepositoryDependencies {
  db: Database;
  github: Pick<GitHubClient, "getRepository" | "getBranchHead">;
  /** The started job queue. */
  queue: () => Promise<JobQueue>;
  /** When email is configured, adding and retrying need a verified address. */
  emailConfigured: boolean;
}

export interface RepositorySummary {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly status: RepositoryStatus;
  readonly failureReason: FailureReason | null;
  readonly commitSha: string;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export interface RepositoryDetails extends RepositorySummary {
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly startedAt: Date | null;
  readonly coverage: {
    readonly listed: number;
    readonly dropped: number;
    readonly unscored: number;
    readonly localOnly: number;
  } | null;
  /** The stored walkthrough document, or `null` until the analysis is done. */
  readonly walkthrough: unknown;
}

export type AddUnavailableReason = "VERIFICATION_REQUIRED" | "REPOSITORY_LIMIT" | "DAILY_LIMIT" | "REQUEST_LIMIT";

export interface AddStatus {
  readonly used: number;
  readonly limit: number;
  /** Why the user cannot add a repository now, if they cannot. */
  readonly unavailable: AddUnavailableReason | null;
}

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

const SUMMARY_COLUMNS = {
  id: true,
  owner: true,
  name: true,
  status: true,
  failureReason: true,
  commitSha: true,
  createdAt: true,
  finishedAt: true,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolve(deps: Partial<RepositoryDependencies>): RepositoryDependencies {
  return {
    db: deps.db ?? defaultDb,
    github: deps.github ?? createGitHubClient(),
    queue: deps.queue ?? getJobQueue,
    emailConfigured: deps.emailConfigured ?? isEmailConfigured(),
  };
}

/**
 * Adds the public GitHub repository at `url` for `user` and queues its
 * analysis. When the user already has it, returns that one instead. Raises
 * `RepositoryRequestError` for every rejection, and saves nothing then.
 */
export async function addRepository(
  user: OnboardingUser,
  url: string,
  deps: Partial<RepositoryDependencies> = {},
): Promise<{ repository: RepositorySummary; created: boolean }> {
  const { db, github, queue, emailConfigured } = resolve(deps);

  const requestId = await recordRequest(db, user.id);

  const parsed = parseRepositoryUrl(url);
  if (!parsed) throw new RepositoryRequestError("INVALID_URL");
  requireVerified(user, emailConfigured);

  // Cheap checks first, so a rejected request costs no GitHub call.
  const existing = await findByName(db, user.id, parsed.owner, parsed.name);
  if (existing) return { repository: existing, created: false };
  await checkLimits(db, user.id, { slots: true });

  const { repository, commit } = await lookUp(github, parsed.owner, parsed.name);
  const jobs = await startedQueue(queue);

  return db.transaction(async (tx) => {
    await lockUser(tx, user.id);

    const again = await findByName(tx, user.id, repository.owner, repository.name);
    if (again) return { repository: again, created: false };
    await checkLimits(tx, user.id, { slots: true });

    const jobId = randomUUID();
    const [row] = await tx
      .insert(repositories)
      .values({
        userId: user.id,
        owner: repository.owner,
        name: repository.name,
        fullNameKey: fullNameKey(repository.owner, repository.name),
        description: repository.description,
        defaultBranch: repository.defaultBranch,
        commitSha: commit,
        jobId,
      })
      .returning(summaryReturning());
    if (!row) throw new Error("The repository was not saved.");

    await markStarted(tx, requestId);
    await sendAnalysis(jobs, tx, { repositoryId: row.id, userId: user.id, jobId });

    return { repository: row, created: true };
  });
}

/**
 * Starts a failed analysis again, from the default branch's latest commit,
 * keeping the repository's slot. Raises `RepositoryNotFoundError` for a
 * repository the user does not have, and `RepositoryRequestError` for every
 * other rejection.
 */
export async function retryAnalysis(
  user: OnboardingUser,
  id: string,
  deps: Partial<RepositoryDependencies> = {},
): Promise<RepositorySummary> {
  const { db, github, queue, emailConfigured } = resolve(deps);

  const requestId = await recordRequest(db, user.id);

  const current = await findOwned(db, user.id, id);
  if (current.status !== "failed") throw new RepositoryRequestError("NOT_RETRYABLE");
  requireVerified(user, emailConfigured);
  await checkLimits(db, user.id, { slots: false });

  const { repository, commit } = await lookUp(github, current.owner, current.name);
  const jobs = await startedQueue(queue);

  return db.transaction(async (tx) => {
    await lockUser(tx, user.id);

    const locked = await findOwned(tx, user.id, id);
    if (locked.status !== "failed") throw new RepositoryRequestError("NOT_RETRYABLE");
    await checkLimits(tx, user.id, { slots: false });

    const jobId = randomUUID();
    const [row] = await tx
      .update(repositories)
      .set({
        description: repository.description,
        defaultBranch: repository.defaultBranch,
        commitSha: commit,
        status: "queued",
        failureReason: null,
        jobId,
        jobAttempt: null,
        startedAt: null,
        finishedAt: null,
        listedCount: null,
        droppedCount: null,
        unscoredCount: null,
        localOnlyCount: null,
        walkthrough: null,
        // The database's clock, which the maintenance job compares it with.
        updatedAt: sql`now()`,
      })
      .where(sql`${repositories.id} = ${id} and ${repositories.userId} = ${user.id}`)
      .returning(summaryReturning());
    if (!row) throw new RepositoryNotFoundError();

    await markStarted(tx, requestId);
    await sendAnalysis(jobs, tx, { repositoryId: row.id, userId: user.id, jobId });

    return row;
  });
}

/**
 * Deletes the repository, its analysis, and its walkthrough, and cancels its
 * job. The slot is free at once. A running analysis notices at its next
 * heartbeat, and nothing it would have saved is kept.
 */
export async function deleteRepository(
  userId: string,
  id: string,
  deps: Partial<RepositoryDependencies> = {},
): Promise<void> {
  const { db, queue } = resolve(deps);
  if (!UUID.test(id)) throw new RepositoryNotFoundError();

  // Deleting works without the queue: a job whose repository is gone does
  // nothing when it runs.
  const jobs = await queue().catch(() => undefined);

  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(repositories)
      .where(sql`${repositories.id} = ${id} and ${repositories.userId} = ${userId}`)
      .returning({ jobId: repositories.jobId });
    if (!row) throw new RepositoryNotFoundError();

    if (jobs) await jobs.cancel(QUEUES.analysis.name, row.jobId, { db: inTransaction(tx) });
  });
}

/** The user's repositories, newest first. */
export async function listRepositories(
  userId: string,
  deps: Partial<Pick<RepositoryDependencies, "db">> = {},
): Promise<RepositorySummary[]> {
  const db = deps.db ?? defaultDb;

  return db.query.repositories.findMany({
    columns: SUMMARY_COLUMNS,
    where: (table, { eq }) => eq(table.userId, userId),
    orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
  });
}

/** One of the user's repositories. Raises `RepositoryNotFoundError` for any other. */
export async function getRepository(
  userId: string,
  id: string,
  deps: Partial<Pick<RepositoryDependencies, "db">> = {},
): Promise<RepositoryDetails> {
  const db = deps.db ?? defaultDb;
  if (!UUID.test(id)) throw new RepositoryNotFoundError();

  const row = await db.query.repositories.findFirst({
    columns: {
      ...SUMMARY_COLUMNS,
      description: true,
      defaultBranch: true,
      startedAt: true,
      listedCount: true,
      droppedCount: true,
      unscoredCount: true,
      localOnlyCount: true,
      walkthrough: true,
    },
    where: (table, { and, eq }) => and(eq(table.id, id), eq(table.userId, userId)),
  });
  if (!row) throw new RepositoryNotFoundError();

  const { listedCount, droppedCount, unscoredCount, localOnlyCount, ...rest } = row;
  const coverage =
    listedCount === null || droppedCount === null || unscoredCount === null || localOnlyCount === null
      ? null
      : { listed: listedCount, dropped: droppedCount, unscored: unscoredCount, localOnly: localOnlyCount };

  return { ...rest, coverage };
}

/** How many slots the user uses, and why they cannot add a repository now, if they cannot. */
export async function getAddStatus(
  user: OnboardingUser,
  deps: Partial<Pick<RepositoryDependencies, "db" | "emailConfigured">> = {},
): Promise<AddStatus> {
  const db = deps.db ?? defaultDb;
  const emailConfigured = deps.emailConfigured ?? isEmailConfigured();
  const counts = await countUsage(db, user.id);

  const unavailable: AddUnavailableReason | null =
    emailConfigured && !user.emailVerified
      ? "VERIFICATION_REQUIRED"
      : counts.repositories >= REPOSITORY_LIMIT
        ? "REPOSITORY_LIMIT"
        : counts.startedToday >= DAILY_ANALYSIS_LIMIT
          ? "DAILY_LIMIT"
          : counts.requestsThisHour >= HOURLY_REQUEST_LIMIT
            ? "REQUEST_LIMIT"
            : null;

  return { used: counts.repositories, limit: REPOSITORY_LIMIT, unavailable };
}

// Records an add or retry request, or rejects it over the hourly limit. Runs
// before anything else, so rejected requests count too.
async function recordRequest(db: Database, userId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const { requestsThisHour } = await countUsage(tx, userId);
    if (requestsThisHour >= HOURLY_REQUEST_LIMIT) throw new RepositoryRequestError("REQUEST_LIMIT");

    const [row] = await tx.insert(analysisRequests).values({ userId }).returning({ id: analysisRequests.id });
    if (!row) throw new Error("The request was not recorded.");
    return row.id;
  });
}

async function markStarted(tx: Transaction, requestId: string): Promise<void> {
  await tx.update(analysisRequests).set({ started: true }).where(sql`${analysisRequests.id} = ${requestId}`);
}

function requireVerified(user: OnboardingUser, emailConfigured: boolean): void {
  if (emailConfigured && !user.emailVerified) throw new RepositoryRequestError("VERIFICATION_REQUIRED");
}

async function checkLimits(db: Executor, userId: string, { slots }: { slots: boolean }): Promise<void> {
  const counts = await countUsage(db, userId);
  if (slots && counts.repositories >= REPOSITORY_LIMIT) throw new RepositoryRequestError("REPOSITORY_LIMIT");
  if (counts.startedToday >= DAILY_ANALYSIS_LIMIT) throw new RepositoryRequestError("DAILY_LIMIT");
}

async function countUsage(db: Executor, userId: string) {
  const result = await db.execute(sql`
    select
      (select count(*)::int from ${repositories} where ${repositories.userId} = ${userId}) as repositories,
      (select count(*)::int from ${analysisRequests}
        where ${analysisRequests.userId} = ${userId}
          and ${analysisRequests.started}
          and ${analysisRequests.createdAt} > now() - interval '24 hours') as "startedToday",
      (select count(*)::int from ${analysisRequests}
        where ${analysisRequests.userId} = ${userId}
          and ${analysisRequests.createdAt} > now() - interval '1 hour') as "requestsThisHour"
  `);
  const row = result.rows[0] as { repositories: number; startedToday: number; requestsThisHour: number };
  return row;
}

// Holds the user's row until the transaction ends, so one user's requests are
// checked and saved one at a time and cannot both take the last slot. The
// worker takes the same lock to start one analysis per user at a time.
export async function lockUser(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(sql`select ${schema.user.id} from ${schema.user} where ${schema.user.id} = ${userId} for update`);
}

async function findByName(
  db: Executor,
  userId: string,
  owner: string,
  name: string,
): Promise<RepositorySummary | undefined> {
  const key = fullNameKey(owner, name);
  return db.query.repositories.findFirst({
    columns: SUMMARY_COLUMNS,
    where: (table, { and, eq }) => and(eq(table.userId, userId), eq(table.fullNameKey, key)),
  });
}

async function findOwned(db: Executor, userId: string, id: string): Promise<RepositorySummary> {
  if (!UUID.test(id)) throw new RepositoryNotFoundError();

  const row = await db.query.repositories.findFirst({
    columns: SUMMARY_COLUMNS,
    where: (table, { and, eq }) => and(eq(table.id, id), eq(table.userId, userId)),
  });
  if (!row) throw new RepositoryNotFoundError();
  return row;
}

async function lookUp(
  github: RepositoryDependencies["github"],
  owner: string,
  name: string,
): Promise<{ repository: Repository; commit: string }> {
  try {
    const repository = await github.getRepository(owner, name);
    const commit = await github.getBranchHead(repository.owner, repository.name, repository.defaultBranch);
    return { repository, commit };
  } catch (error) {
    if (error instanceof GitHubNotFoundError) throw new RepositoryRequestError("REPOSITORY_NOT_FOUND");
    if (error instanceof GitHubEmptyRepositoryError) throw new RepositoryRequestError("REPOSITORY_EMPTY");
    if (error instanceof GitHubRateLimitError || error instanceof GitHubUnavailableError) {
      throw new RepositoryRequestError("GITHUB_UNAVAILABLE");
    }
    throw error;
  }
}

async function startedQueue(queue: () => Promise<JobQueue>): Promise<JobQueue> {
  try {
    return await queue();
  } catch (error) {
    if (error instanceof JobQueueUnavailableError) throw new RepositoryRequestError("QUEUE_UNAVAILABLE");
    throw error;
  }
}

function fullNameKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

function summaryReturning() {
  return {
    id: repositories.id,
    owner: repositories.owner,
    name: repositories.name,
    status: repositories.status,
    failureReason: repositories.failureReason,
    commitSha: repositories.commitSha,
    createdAt: repositories.createdAt,
    finishedAt: repositories.finishedAt,
  };
}
