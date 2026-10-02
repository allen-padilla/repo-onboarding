import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { schema, sql } from "@startup/db";
import {
  GitHubEmptyRepositoryError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubUnavailableError,
  type Repository,
} from "@startup/github";
import { JobQueueUnavailableError, QUEUES } from "@startup/jobs";
import { createTestJobQueueTemplate, type TestJobQueue } from "@startup/jobs/testing";

import { RepositoryNotFoundError, RepositoryRequestError, type RepositoryRequestCode } from "./errors";
import {
  addRepository,
  deleteRepository,
  getAddStatus,
  getRepository,
  listRepositories,
  retryAnalysis,
  type OnboardingUser,
  type RepositoryDependencies,
} from "./repositories";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NEW_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

const alice: OnboardingUser = { id: "alice", emailVerified: true };
const bob: OnboardingUser = { id: "bob", emailVerified: true };
const carol: OnboardingUser = { id: "carol", emailVerified: false };

type GitHubEntry = { repository: Repository; commit: string | Error } | Error;

/** A GitHub client that answers from `entries`, keyed by lowercase `owner/name`, and records calls. */
function fakeGitHub(entries: Record<string, GitHubEntry>) {
  const calls: string[] = [];
  const entry = (owner: string, name: string) => entries[`${owner}/${name}`.toLowerCase()];

  return {
    calls,
    entries,
    client: {
      async getRepository(owner: string, name: string) {
        calls.push(`${owner}/${name}`);
        const found = entry(owner, name);
        if (!found) throw new GitHubNotFoundError();
        if (found instanceof Error) throw found;
        return found.repository;
      },
      async getBranchHead(owner: string, name: string) {
        const found = entry(owner, name);
        if (!found || found instanceof Error) throw new GitHubNotFoundError();
        if (found.commit instanceof Error) throw found.commit;
        return found.commit;
      },
    },
  };
}

function publicRepository(owner: string, name: string, commit = COMMIT): GitHubEntry {
  return { repository: { owner, name, description: `${name} description`, defaultBranch: "main" }, commit };
}

let template: Awaited<ReturnType<typeof createTestJobQueueTemplate>>;
let env: TestJobQueue;
let github: ReturnType<typeof fakeGitHub>;

beforeAll(async () => {
  template = await createTestJobQueueTemplate();
});

afterAll(async () => {
  await template.close();
});

beforeEach(async () => {
  env = await template.create();
  for (const user of [alice, bob, carol]) {
    await env.db.insert(schema.user).values({
      id: user.id,
      name: user.id,
      email: `${user.id}@example.com`,
      emailVerified: user.emailVerified,
    });
  }
  github = fakeGitHub({
    "acme/widget": publicRepository("Acme", "Widget"),
    "acme/gadget": publicRepository("Acme", "Gadget"),
    "acme/empty": { repository: { owner: "acme", name: "empty", description: null, defaultBranch: "main" }, commit: new GitHubEmptyRepositoryError() },
    "acme/limited": new GitHubRateLimitError(new Date(Date.now() + 60_000)),
    "acme/down": new GitHubUnavailableError("status", 502),
    ...Object.fromEntries(
      ["r1", "r2", "r3", "r4", "r5", "r6"].map((name) => [`acme/${name}`, publicRepository("acme", name)]),
    ),
  });
});

afterEach(async () => {
  await env.close();
});

function deps(overrides: Partial<RepositoryDependencies> = {}): Partial<RepositoryDependencies> {
  return {
    db: env.db,
    github: github.client,
    queue: async () => env.boss,
    emailConfigured: true,
    ...overrides,
  };
}

async function rejectionCode(promise: Promise<unknown>): Promise<RepositoryRequestCode> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RepositoryRequestError);
  return (error as RepositoryRequestError).code;
}

async function rows(userId: string) {
  return env.db.query.repositories.findMany({ where: (table, { eq }) => eq(table.userId, userId) });
}

async function requests(userId: string) {
  return env.db.query.analysisRequests.findMany({ where: (table, { eq }) => eq(table.userId, userId) });
}

async function job(jobId: string) {
  const [found] = await env.boss.findJobs(QUEUES.analysis.name, { id: jobId });
  return found;
}

/**
 * Adds `count` request rows for `userId`, created `hoursAgo` hours ago. The
 * time comes from the database's clock, as in the code under test: the column
 * has no time zone, so a time written from JavaScript (UTC) would be read in
 * the database session's time zone.
 */
async function pastRequests(userId: string, count: number, { started, hoursAgo }: { started: boolean; hoursAgo: number }) {
  for (let index = 0; index < count; index += 1) {
    await env.db.insert(schema.analysisRequests).values({
      userId,
      started,
      createdAt: sql`now() - make_interval(secs => ${hoursAgo * 3600})`,
    });
  }
}

async function fail(id: string) {
  await env.db
    .update(schema.repositories)
    .set({ status: "failed", failureReason: "writer_failed", walkthrough: { kind: "old" }, listedCount: 3 })
    .where(sql`${schema.repositories.id} = ${id}`);
}

describe("addRepository", () => {
  it("saves the repository with GitHub's canonical name and queues its analysis in the same transaction", async () => {
    const { repository, created } = await addRepository(alice, "https://github.com/acme/widget/tree/main/src", deps());

    expect(created).toBe(true);
    expect(repository).toMatchObject({ owner: "Acme", name: "Widget", status: "queued", failureReason: null, commitSha: COMMIT });

    const [row] = await rows(alice.id);
    expect(row).toMatchObject({ fullNameKey: "acme/widget", description: "Widget description", defaultBranch: "main" });

    const queued = await job(row!.jobId);
    expect(queued).toMatchObject({ state: "created", data: { repositoryId: repository.id }, groupId: alice.id });
    expect(await requests(alice.id)).toEqual([expect.objectContaining({ started: true })]);
  });

  it("opens the existing repository for another URL form, without calling GitHub or starting an analysis", async () => {
    const first = await addRepository(alice, "github.com/acme/widget", deps());
    const callsBefore = github.calls.length;

    const second = await addRepository(alice, "https://www.github.com/ACME/Widget.git", deps());

    expect(second).toEqual({ repository: first.repository, created: false });
    expect(github.calls).toHaveLength(callsBefore);
    expect(await rows(alice.id)).toHaveLength(1);
    expect((await requests(alice.id)).filter((request) => request.started)).toHaveLength(1);
  });

  it("opens the existing repository when a renamed URL leads to it", async () => {
    github.entries["acme/old-name"] = publicRepository("Acme", "Widget");
    await addRepository(alice, "github.com/acme/widget", deps());

    const result = await addRepository(alice, "github.com/acme/old-name", deps());

    expect(result.created).toBe(false);
    expect(result.repository.name).toBe("Widget");
    expect(await rows(alice.id)).toHaveLength(1);
  });

  it("gives two users their own copy of the same repository", async () => {
    await addRepository(alice, "github.com/acme/widget", deps());
    const { created } = await addRepository(bob, "github.com/acme/widget", deps());

    expect(created).toBe(true);
    expect(await rows(bob.id)).toHaveLength(1);
  });

  it.each([
    ["a URL that is not a GitHub repository", "https://gitlab.com/acme/widget", "INVALID_URL"],
    ["a private or missing repository", "github.com/acme/secret", "REPOSITORY_NOT_FOUND"],
    ["an empty repository", "github.com/acme/empty", "REPOSITORY_EMPTY"],
    ["a GitHub rate limit", "github.com/acme/limited", "GITHUB_UNAVAILABLE"],
    ["GitHub being down", "github.com/acme/down", "GITHUB_UNAVAILABLE"],
  ])("rejects %s and saves nothing", async (_case, url, code) => {
    expect(await rejectionCode(addRepository(alice, url, deps()))).toBe(code);

    expect(await rows(alice.id)).toEqual([]);
    expect(await requests(alice.id)).toEqual([expect.objectContaining({ started: false })]);
  });

  it("rejects an invalid URL without calling GitHub", async () => {
    await rejectionCode(addRepository(alice, "not a url", deps()));

    expect(github.calls).toEqual([]);
  });

  it("requires a verified address when email is configured, before calling GitHub", async () => {
    expect(await rejectionCode(addRepository(carol, "github.com/acme/widget", deps()))).toBe("VERIFICATION_REQUIRED");
    expect(github.calls).toEqual([]);

    const { created } = await addRepository(carol, "github.com/acme/widget", deps({ emailConfigured: false }));
    expect(created).toBe(true);
  });

  it("allows 5 repositories, rejects a sixth without calling GitHub, and frees a slot on delete", async () => {
    const added = [];
    for (const name of ["r1", "r2", "r3", "r4", "r5"]) {
      added.push((await addRepository(alice, `github.com/acme/${name}`, deps())).repository);
    }
    const callsBefore = github.calls.length;

    expect(await rejectionCode(addRepository(alice, "github.com/acme/r6", deps()))).toBe("REPOSITORY_LIMIT");
    expect(github.calls).toHaveLength(callsBefore);

    await deleteRepository(alice.id, added[0]!.id, deps());
    const { created } = await addRepository(alice, "github.com/acme/r6", deps());
    expect(created).toBe(true);
  });

  it("allows 10 analyses per 24 hours, counting those of deleted repositories", async () => {
    await pastRequests(alice.id, 9, { started: true, hoursAgo: 23 });
    await pastRequests(alice.id, 5, { started: true, hoursAgo: 25 });
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());
    await deleteRepository(alice.id, repository.id, deps());

    expect(await rejectionCode(addRepository(alice, "github.com/acme/gadget", deps()))).toBe("DAILY_LIMIT");
  });

  it("allows 20 requests per hour, rejected ones included", async () => {
    await pastRequests(alice.id, 5, { started: false, hoursAgo: 2 });
    for (let index = 0; index < 20; index += 1) {
      await rejectionCode(addRepository(alice, "not a url", deps()));
    }

    expect(await rejectionCode(addRepository(alice, "github.com/acme/widget", deps()))).toBe("REQUEST_LIMIT");
    expect(github.calls).toEqual([]);
  });

  it("saves nothing when the job queue is unavailable", async () => {
    const unavailable = deps({
      queue: () => Promise.reject(new JobQueueUnavailableError("migration_required")),
    });

    expect(await rejectionCode(addRepository(alice, "github.com/acme/widget", unavailable))).toBe("QUEUE_UNAVAILABLE");
    expect(await rows(alice.id)).toEqual([]);
  });

  it("rolls the repository back when sending its job fails", async () => {
    const failing = deps({
      queue: async () =>
        ({
          send: () => Promise.reject(new Error("send failed")),
        }) as unknown as TestJobQueue["boss"],
    });

    await expect(addRepository(alice, "github.com/acme/widget", failing)).rejects.toThrow("send failed");
    expect(await rows(alice.id)).toEqual([]);
    expect((await requests(alice.id)).filter((request) => request.started)).toEqual([]);
  });
});

describe("retryAnalysis", () => {
  it("queues a failed analysis again from the latest commit, keeping its slot and clearing old results", async () => {
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());
    const [before] = await rows(alice.id);
    await fail(repository.id);
    github.entries["acme/widget"] = publicRepository("Acme", "Widget", NEW_COMMIT);

    const retried = await retryAnalysis(alice, repository.id, deps());

    expect(retried).toMatchObject({ id: repository.id, status: "queued", failureReason: null, commitSha: NEW_COMMIT });
    const [after] = await rows(alice.id);
    expect(after).toMatchObject({ walkthrough: null, listedCount: null, jobAttempt: null });
    expect(after!.jobId).not.toBe(before!.jobId);
    expect(await job(after!.jobId)).toMatchObject({ state: "created", groupId: alice.id });
    expect(await rows(alice.id)).toHaveLength(1);
    expect((await requests(alice.id)).filter((request) => request.started)).toHaveLength(2);
  });

  it("only retries a failed analysis", async () => {
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());

    expect(await rejectionCode(retryAnalysis(alice, repository.id, deps()))).toBe("NOT_RETRYABLE");
  });

  it("rejects a repository that went private, and leaves it failed", async () => {
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());
    await fail(repository.id);
    delete github.entries["acme/widget"];

    expect(await rejectionCode(retryAnalysis(alice, repository.id, deps()))).toBe("REPOSITORY_NOT_FOUND");
    expect(await getRepository(alice.id, repository.id, deps())).toMatchObject({ status: "failed" });
  });

  it("counts toward the daily cap", async () => {
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());
    await fail(repository.id);
    await pastRequests(alice.id, 9, { started: true, hoursAgo: 1 });

    expect(await rejectionCode(retryAnalysis(alice, repository.id, deps()))).toBe("DAILY_LIMIT");
  });

  it("requires a verified address when email is configured, and not when it is disabled", async () => {
    const { repository } = await addRepository(carol, "github.com/acme/widget", deps({ emailConfigured: false }));
    await fail(repository.id);

    expect(await rejectionCode(retryAnalysis(carol, repository.id, deps()))).toBe("VERIFICATION_REQUIRED");
    expect((await retryAnalysis(carol, repository.id, deps({ emailConfigured: false }))).status).toBe("queued");
  });
});

describe("deleteRepository", () => {
  it("deletes the repository and cancels its job", async () => {
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());
    const [row] = await rows(alice.id);

    await deleteRepository(alice.id, repository.id, deps());

    expect(await rows(alice.id)).toEqual([]);
    expect(await job(row!.jobId)).toMatchObject({ state: "cancelled" });
  });

  it("still deletes when the job queue is unavailable", async () => {
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());

    await deleteRepository(alice.id, repository.id, deps({ queue: () => Promise.reject(new Error("down")) }));

    expect(await rows(alice.id)).toEqual([]);
  });
});

describe("ownership", () => {
  it("treats another user's repository, and a malformed ID, as missing", async () => {
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());
    await fail(repository.id);

    for (const id of [repository.id, "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
      await expect(getRepository(bob.id, id, deps())).rejects.toBeInstanceOf(RepositoryNotFoundError);
      await expect(retryAnalysis(bob, id, deps())).rejects.toBeInstanceOf(RepositoryNotFoundError);
      await expect(deleteRepository(bob.id, id, deps())).rejects.toBeInstanceOf(RepositoryNotFoundError);
    }
    expect(await rows(alice.id)).toHaveLength(1);
  });
});

describe("reading", () => {
  it("lists only the user's repositories, newest first", async () => {
    await addRepository(alice, "github.com/acme/widget", deps());
    await addRepository(alice, "github.com/acme/gadget", deps());
    await addRepository(bob, "github.com/acme/r1", deps());

    expect((await listRepositories(alice.id, deps())).map((repository) => repository.name)).toEqual(["Gadget", "Widget"]);
  });

  it("returns a repository's details, with coverage once it is known", async () => {
    const { repository } = await addRepository(alice, "github.com/acme/widget", deps());

    expect(await getRepository(alice.id, repository.id, deps())).toMatchObject({
      description: "Widget description",
      defaultBranch: "main",
      coverage: null,
      walkthrough: null,
    });

    await env.db
      .update(schema.repositories)
      .set({ listedCount: 40, droppedCount: 10, unscoredCount: 0, localOnlyCount: 30 })
      .where(sql`${schema.repositories.id} = ${repository.id}`);
    expect((await getRepository(alice.id, repository.id, deps())).coverage).toEqual({
      listed: 40,
      dropped: 10,
      unscored: 0,
      localOnly: 30,
    });
  });
});

describe("getAddStatus", () => {
  it("reports the slots used and that adding is available", async () => {
    await addRepository(alice, "github.com/acme/widget", deps());

    expect(await getAddStatus(alice, deps())).toEqual({ used: 1, limit: 5, unavailable: null });
  });

  it("reports each reason adding is unavailable", async () => {
    expect((await getAddStatus(carol, deps())).unavailable).toBe("VERIFICATION_REQUIRED");
    expect((await getAddStatus(carol, deps({ emailConfigured: false }))).unavailable).toBeNull();

    await pastRequests(bob.id, 20, { started: false, hoursAgo: 0.5 });
    expect((await getAddStatus(bob, deps())).unavailable).toBe("REQUEST_LIMIT");

    await pastRequests(bob.id, 10, { started: true, hoursAgo: 3 });
    expect((await getAddStatus(bob, deps())).unavailable).toBe("DAILY_LIMIT");

    for (const name of ["r1", "r2", "r3", "r4", "r5"]) {
      await addRepository(alice, `github.com/acme/${name}`, deps());
    }
    expect(await getAddStatus(alice, deps())).toEqual({ used: 5, limit: 5, unavailable: "REPOSITORY_LIMIT" });
  });
});
