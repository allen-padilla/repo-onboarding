import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, sql } from "@startup/db";
import { GenerationProviderError, type GenerateObjectRequest, type GenerationClient } from "@startup/generation";
import { GitHubRateLimitError, GitHubRepositoryTooLargeError } from "@startup/github";
import { QUEUES, type Job } from "@startup/jobs";
import { createTestJobQueueTemplate, TestClock, type TestJobQueue } from "@startup/jobs/testing";

import { AnalysisError } from "./analysis/errors";
import { createAnalysisHandlers } from "./analysis/handlers";
import type { WriterOutput } from "./analysis/walkthrough";
import { GITHUB_RATE_LIMIT_REQUEUES } from "./limits";
import type { AnalysisJobData } from "./queue";
import { addRepository, deleteRepository, retryAnalysis, type OnboardingUser } from "./repositories";
import { FIXTURE_COMMIT, FIXTURE_MARKER, fakeGitHub, type FakeRepository } from "./testing/github";
import { parseWalkthroughDocument } from "./walkthrough-document";
import { startAnalysisWorker, type AnalysisWorker, type AnalysisWorkerDependencies } from "./worker";

const MINUTE = 60_000;

const alice: OnboardingUser = { id: "alice", emailVerified: true };

const fixture = (name: string): FakeRepository => ({
  owner: "acme",
  name,
  description: "Serves widgets.",
  files: {
    "README.md": "# Widget",
    "package.json": "{}",
    "src/index.ts": "export {};",
    "src/server/routes.ts": "export const routes = [];",
    "test/routes.test.ts": "test();",
  },
});

const writerOutput: WriterOutput = {
  summary: ["Serves widgets from `src/index.ts`."],
  directories: [{ path: "src", description: "Application code." }],
  keyFiles: [{ path: "src/index.ts", why: "Starts the server." }],
  readingOrder: [{ path: "README.md", reason: "Overview." }],
};

let template: Awaited<ReturnType<typeof createTestJobQueueTemplate>>;
let env: TestJobQueue;
let clock: TestClock;
let github: ReturnType<typeof fakeGitHub>;
let reports: { error: AnalysisError; repositoryId: string }[];
const workers: AnalysisWorker[] = [];

beforeAll(async () => {
  template = await createTestJobQueueTemplate();
});

afterAll(async () => {
  await template.close();
});

beforeEach(async () => {
  clock = new TestClock();
  env = await template.create({ clock, __test__enableSpies: true });
  await env.db.insert(schema.user).values({ id: alice.id, name: alice.id, email: "alice@example.com", emailVerified: true });
  github = fakeGitHub([fixture("widget"), fixture("gadget")]);
  reports = [];
});

afterEach(async () => {
  github.setGate(undefined);
  for (const worker of workers.splice(0)) await worker.stop();
  await env.close();
});

function dependencies(overrides: Partial<AnalysisWorkerDependencies> = {}): AnalysisWorkerDependencies {
  return {
    db: env.db,
    github: github.client,
    decision: null,
    generation: null,
    now: () => clock.now(),
    sleep: async () => undefined,
    timeLimitMs: 15 * MINUTE,
    report: (error, { repositoryId }) => reports.push({ error, repositoryId }),
    ...overrides,
  };
}

async function start(overrides: Partial<AnalysisWorkerDependencies> = {}): Promise<AnalysisWorker> {
  const worker = await startAnalysisWorker(env.boss, dependencies(overrides));
  workers.push(worker);
  return worker;
}

const repositoryDeps = () => ({
  db: env.db,
  github: github.client,
  queue: async () => env.boss,
  emailConfigured: false,
});

async function add(name = "widget") {
  const { repository } = await addRepository(alice, `https://github.com/acme/${name}`, repositoryDeps());
  return (await row(repository.id))!;
}

async function row(id: string) {
  return env.db.query.repositories.findFirst({ where: (table, { eq }) => eq(table.id, id) });
}

async function job(id: string) {
  const [found] = await env.boss.findJobs<AnalysisJobData>(QUEUES.analysis.name, { id });
  return found;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Ticks the clock, so workers poll and heartbeat, until `check` holds. */
async function eventually(check: () => Promise<boolean> | boolean, stepMs = 2_000): Promise<void> {
  for (let step = 0; step < 60; step += 1) {
    if (await check()) return;
    await clock.tick(stepMs);
    await settle();
  }
  throw new Error("The condition was not reached.");
}

async function completed(jobId: string) {
  let done = false;
  void env.boss
    .getSpy(QUEUES.analysis.name)
    .waitForJobWithId(jobId, "completed")
    .then(() => (done = true));
  await eventually(() => done);
}

/** No handler is running. */
const idle = () => env.boss.getWipData().every((worker) => worker.count === 0);

/** Holds `method` for `repository` until its signal aborts. Resolves once a call is held. */
function hold(method: "getTree" | "readFiles", repository = "acme/widget") {
  let held!: () => void;
  const reached = new Promise<void>((resolve) => (held = resolve));
  github.setGate(async (called, signal, name) => {
    if (called !== method || name !== repository) return;
    held();
    await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  return reached;
}

function writer(replies: (WriterOutput | Error)[]) {
  const requests: GenerateObjectRequest<unknown>[] = [];
  const client: Pick<GenerationClient, "generateObject"> = {
    async generateObject<T>(request: GenerateObjectRequest<T>) {
      requests.push(request as GenerateObjectRequest<unknown>);
      const reply = replies[Math.min(requests.length, replies.length) - 1]!;
      if (reply instanceof Error) throw reply;
      return { output: reply as T, model: "claude-test", fellBack: false, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { requests, client };
}

function fakeJob(
  jobId: string,
  repositoryId: string,
  retryCount = 0,
  data: Omit<AnalysisJobData, "repositoryId"> = {},
): Job<AnalysisJobData> {
  return {
    id: jobId,
    name: QUEUES.analysis.name,
    data: { repositoryId, ...data },
    retryCount,
    signal: new AbortController().signal,
    expireInSeconds: 960,
    heartbeatSeconds: 30,
  };
}

// Every table, including pg-boss's, as text.
async function everything(): Promise<string> {
  const { rows } = await env.db.execute(sql`
    select table_schema, table_name from information_schema.tables
    where table_schema in ('public', 'pgboss') and table_type = 'BASE TABLE'
  `);
  const dumps: string[] = [];
  for (const { table_schema, table_name } of rows as { table_schema: string; table_name: string }[]) {
    const result = await env.db.execute(sql.raw(`select * from "${table_schema}"."${table_name}"`));
    dumps.push(JSON.stringify(result.rows));
  }
  return dumps.join("\n");
}

describe("the analysis worker", () => {
  it("runs a queued analysis to done", async () => {
    const repository = await add();
    await start();

    await completed(repository.jobId);

    const saved = (await row(repository.id))!;
    expect(saved).toMatchObject({
      status: "done",
      failureReason: null,
      jobAttempt: 0,
      listedCount: 5,
      droppedCount: 0,
      unscoredCount: 0,
      localOnlyCount: 5,
    });
    expect(saved.startedAt).toBeInstanceOf(Date);
    expect(saved.finishedAt).toBeInstanceOf(Date);
    expect(parseWalkthroughDocument(saved.walkthrough)?.kind).toBe("basic");
    expect(reports).toEqual([]);
  });

  it("schedules the maintenance job every hour", async () => {
    await start();

    expect(await env.boss.getSchedules(QUEUES.onboardingMaintenance.name)).toMatchObject([{ cron: "0 * * * *" }]);
  });

  it("fails as not found when the repository was made private while queued", async () => {
    const repository = await add();
    github.repositories.get("acme/widget")!.private = true;
    await start();

    await completed(repository.jobId);

    expect(await row(repository.id)).toMatchObject({ status: "failed", failureReason: "not_found", walkthrough: null });
  });

  it("writes the walkthrough when the writing model is configured", async () => {
    const repository = await add();
    const model = writer([writerOutput]);
    await start({ generation: model.client });

    await completed(repository.jobId);

    expect(parseWalkthroughDocument((await row(repository.id))!.walkthrough)?.kind).toBe("written");
    expect(model.requests).toHaveLength(1);
  });

  it("fails as writer failed, and a retry can then succeed", async () => {
    const repository = await add();
    const model = writer([new GenerationProviderError("status", 529), writerOutput]);
    await start({ generation: model.client });

    await completed(repository.jobId);
    expect(await row(repository.id)).toMatchObject({ status: "failed", failureReason: "writer_failed", listedCount: 5 });

    await retryAnalysis(alice, repository.id, repositoryDeps());
    const retried = (await row(repository.id))!;
    await completed(retried.jobId);

    expect(await row(repository.id)).toMatchObject({ status: "done", failureReason: null });
  });

  it("saves nothing for a repository deleted while its analysis runs", async () => {
    const repository = await add();
    const held = hold("getTree");
    await start();
    await eventually(async () => {
      await settle();
      return (await row(repository.id))?.status === "running";
    });
    await held;

    await deleteRepository(alice.id, repository.id, { db: env.db, queue: async () => env.boss });
    // The next heartbeat finds the job cancelled and aborts the run.
    await eventually(idle);

    expect(await row(repository.id)).toBeUndefined();
    expect((await job(repository.jobId))?.state).toBe("cancelled");
    expect(await env.boss.findJobs(QUEUES.analysis.name)).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it("runs one analysis per user at a time", async () => {
    const first = await add("widget");
    const second = await add("gadget");
    const held = hold("getTree", "acme/widget");
    await start();
    await held;

    for (let step = 0; step < 5; step += 1) await clock.tick(2_000);
    expect(await row(second.id)).toMatchObject({ status: "queued", jobAttempt: null });

    github.setGate(undefined);
    await workers[0]!.stop();
    workers.length = 0;
    await start();
    await eventually(async () => (await row(first.id))?.status === "done" && (await row(second.id))?.status === "done");
  });

  it("queues a user's analysis again while another of theirs is running", async () => {
    const first = await add("widget");
    const second = await add("gadget");
    await env.db.update(schema.repositories).set({ status: "running" }).where(sql`${schema.repositories.id} = ${first.id}`);
    const handlers = createAnalysisHandlers(env.boss, dependencies(), new AbortController().signal);
    const calls = github.calls.length;

    await handlers.analysis(fakeJob(second.jobId, second.id));

    const saved = (await row(second.id))!;
    expect(saved).toMatchObject({ status: "queued", jobAttempt: null });
    expect(saved.jobId).not.toBe(second.jobId);
    const next = (await job(saved.jobId))!;
    expect(next.startAfter.getTime()).toBeGreaterThanOrEqual(clock.now() + 14_000);
    expect(next.groupId).toBe(alice.id);
    expect(github.calls.length).toBe(calls);
  });

  it("returns an interrupted analysis to queued on shutdown, and starts it over", async () => {
    const repository = await add();
    const held = hold("readFiles");
    const worker = await start();
    await eventually(async () => {
      await settle();
      return (await row(repository.id))?.status === "running";
    });
    await held;

    await worker.stop();

    expect(await row(repository.id)).toMatchObject({ status: "queued" });
    const interrupted = (await job(repository.jobId))!;
    expect(interrupted.state).toBe("retry");
    expect(interrupted.output).toMatchObject({ name: "AnalysisInterruptedError", reason: "shutdown" });

    github.setGate(undefined);
    await start();
    await completed(repository.jobId);

    expect(await row(repository.id)).toMatchObject({ status: "done", jobAttempt: 1 });
  });

  it("queues a job claimed during shutdown again at once, keeping its interrupted runs", async () => {
    const repository = await add();
    const stopping = new AbortController();
    stopping.abort();
    const handlers = createAnalysisHandlers(env.boss, dependencies(), stopping.signal);
    const calls = github.calls.length;

    // The retry of a run that was interrupted once.
    await handlers.analysis(fakeJob(repository.jobId, repository.id, 1));

    const saved = (await row(repository.id))!;
    expect(saved).toMatchObject({ status: "queued", jobAttempt: null });
    const next = (await job(saved.jobId))!;
    expect(next.data.interruptions).toBe(1);
    expect(next.startAfter.getTime()).toBeLessThanOrEqual(clock.now() + 1_000);
    expect(github.calls.length).toBe(calls);
  });

  it("fails without running once interruptions across re-queued jobs use up the retry", async () => {
    const repository = await add();
    const handlers = createAnalysisHandlers(env.boss, dependencies(), new AbortController().signal);
    const calls = github.calls.length;

    // Interrupted once under an earlier job, and once more under this one.
    await handlers.analysis(fakeJob(repository.jobId, repository.id, 1, { interruptions: 1 }));

    expect(await row(repository.id)).toMatchObject({ status: "failed", failureReason: "unexpected" });
    expect(github.calls.length).toBe(calls);
  });

  it("fails an analysis interrupted a second time", async () => {
    const repository = await add();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const held = hold("readFiles");
      const worker = await start();
      await held;
      await worker.stop();
      workers.length = 0;
    }

    expect(await row(repository.id)).toMatchObject({ status: "failed", failureReason: "unexpected" });
    expect((await job(repository.jobId))?.state).toBe("failed");
  });

  it("retries a lost heartbeat once, then the dead-letter handler fails the analysis", async () => {
    const repository = await add();

    // A worker claims the job and dies: nothing refreshes its heartbeat.
    const [first] = await env.boss.fetch(QUEUES.analysis.name);
    expect(first?.id).toBe(repository.jobId);
    await clock.setTime(clock.now() + 61_000);
    await env.boss.supervise(QUEUES.analysis.name);
    expect((await job(repository.jobId))?.state).toBe("retry");

    const [second] = await env.boss.fetch(QUEUES.analysis.name);
    expect(second).toMatchObject({ id: repository.jobId, retryCount: 1 });
    await clock.setTime(clock.now() + 61_000);
    await env.boss.supervise(QUEUES.analysis.name);
    expect((await job(repository.jobId))?.state).toBe("failed");

    await start();
    await eventually(async () => (await row(repository.id))?.status === "failed");
    expect(await row(repository.id)).toMatchObject({ failureReason: "unexpected" });
  });

  it("never lets a stale attempt overwrite its retry", async () => {
    const repository = await add();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    github.setGate(async (method) => {
      if (method !== "getTree" || ++calls > 1) return;
      await released;
      throw new GitHubRepositoryTooLargeError("listing_truncated");
    });
    const handlers = createAnalysisHandlers(env.boss, dependencies(), new AbortController().signal);

    // Attempt 0 lost its claim but keeps running; attempt 1 finishes first.
    const stale = handlers.analysis(fakeJob(repository.jobId, repository.id, 0));
    await eventually(() => calls === 1);
    await handlers.analysis(fakeJob(repository.jobId, repository.id, 1));
    release();
    await stale;

    expect(await row(repository.id)).toMatchObject({ status: "done", jobAttempt: 1, failureReason: null });
  });

  it("fails as timed out after the time limit", async () => {
    const repository = await add();
    void hold("readFiles");
    await start({ timeLimitMs: 100 });

    await completed(repository.jobId);

    expect(await row(repository.id)).toMatchObject({ status: "failed", failureReason: "timed_out" });
  });

  it("queues the analysis again after a GitHub rate limit, at most 3 times", async () => {
    const repository = await add();
    github.setGate(async (method) => {
      if (method === "getRepository") throw new GitHubRateLimitError(new Date(clock.now() + 10 * MINUTE));
    });
    await start();

    let current = repository.jobId;
    for (let deferral = 1; deferral <= GITHUB_RATE_LIMIT_REQUEUES; deferral += 1) {
      await completed(current);
      const saved = (await row(repository.id))!;
      expect(saved.status).toBe("queued");
      expect(saved.jobId).not.toBe(current);

      const next = (await job(saved.jobId))!;
      expect(next.data.rateLimitDeferrals).toBe(deferral);
      expect(next.startAfter.getTime()).toBeGreaterThanOrEqual(clock.now() + 9 * MINUTE);
      current = saved.jobId;
      await clock.setTime(next.startAfter.getTime() + 1_000);
    }

    await completed(current);
    expect(await row(repository.id)).toMatchObject({ status: "failed", failureReason: "github_rate_limit", jobId: current });
  });

  it("keeps no file contents after runs that succeed and fail", async () => {
    const done = await add("widget");
    const failing = await add("gadget");
    github.setGate(async (method, _signal, name) => {
      if (method === "readFiles" && name === "acme/gadget") {
        throw Object.assign(new Error(`could not read ${FIXTURE_MARKER}`), { detail: FIXTURE_MARKER });
      }
    });
    const model = writer([writerOutput]);
    await start({ generation: model.client });

    await completed(done.jobId);
    await eventually(async () => (await row(failing.id))?.status === "failed" && idle());
    await eventually(async () => {
      const dead = await env.boss.findJobs(QUEUES.analysisFailed.name);
      return dead.length === 1 && dead[0]!.state === "completed";
    });

    expect(JSON.parse(model.requests[0]!.content).files[0].content).toContain(FIXTURE_MARKER);
    expect(await row(failing.id)).toMatchObject({ failureReason: "unexpected" });
    expect(reports.map(({ error }) => [error.name, error.step, error.type])).toEqual([
      ["AnalysisError", "download", "Error"],
      ["AnalysisError", "download", "Error"],
    ]);
    expect(await everything()).not.toContain(FIXTURE_MARKER);
  });
});

describe("the maintenance job", () => {
  async function insertRepository(name: string, values: { status: "queued" | "running"; jobId: string; minutesAgo: number }) {
    const [inserted] = await env.db
      .insert(schema.repositories)
      .values({
        userId: alice.id,
        owner: "acme",
        name,
        fullNameKey: `acme/${name}`,
        defaultBranch: "main",
        commitSha: FIXTURE_COMMIT,
        status: values.status,
        jobId: values.jobId,
        updatedAt: sql`now() - make_interval(mins => ${values.minutesAgo})`,
      })
      .returning({ id: schema.repositories.id });
    return inserted!.id;
  }

  it("fails analyses stuck without a job that could finish them", async () => {
    const waiting = await add("widget");
    await env.db
      .update(schema.repositories)
      .set({ updatedAt: sql`now() - interval '45 minutes'` })
      .where(sql`${schema.repositories.id} = ${waiting.id}`);
    const missing = await insertRepository("missing", { status: "running", jobId: randomUUID(), minutesAgo: 30 });
    const recent = await insertRepository("recent", { status: "queued", jobId: randomUUID(), minutesAgo: 5 });
    const finishedJob = randomUUID();
    await env.boss.send(QUEUES.analysis.name, { repositoryId: "x" }, { id: finishedJob });
    await env.boss.cancel(QUEUES.analysis.name, finishedJob);
    const finished = await insertRepository("finished", { status: "queued", jobId: finishedJob, minutesAgo: 30 });
    const handlers = createAnalysisHandlers(env.boss, dependencies(), new AbortController().signal);

    await handlers.maintenance();

    expect(await row(missing)).toMatchObject({ status: "failed", failureReason: "unexpected" });
    expect(await row(finished)).toMatchObject({ status: "failed", failureReason: "unexpected" });
    expect(await row(recent)).toMatchObject({ status: "queued" });
    expect(await row(waiting.id)).toMatchObject({ status: "queued" });
  });

  it("deletes requests older than 24 hours", async () => {
    await env.db.insert(schema.analysisRequests).values([
      { userId: alice.id, createdAt: sql`now() - interval '25 hours'` },
      { userId: alice.id, started: true, createdAt: sql`now() - interval '25 hours'` },
      { userId: alice.id, createdAt: sql`now() - interval '23 hours'` },
    ]);
    const handlers = createAnalysisHandlers(env.boss, dependencies(), new AbortController().signal);

    await handlers.maintenance();

    expect(await env.db.query.analysisRequests.findMany()).toHaveLength(1);
  });
});

describe("handler errors", () => {
  it("are reduced to a step and a type", () => {
    const error = new AnalysisError("download", Object.assign(new TypeError(`bad ${FIXTURE_MARKER}`), { body: FIXTURE_MARKER }));

    expect(error).toMatchObject({ name: "AnalysisError", step: "download", type: "TypeError" });
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(FIXTURE_MARKER);
    expect(error).not.toHaveProperty("cause");
  });
});
