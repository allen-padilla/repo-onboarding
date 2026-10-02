import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getSession } from "@startup/auth/next";
import { getRepository, RepositoryNotFoundError, type RepositoryDetails } from "@startup/onboarding";
import { githubUrl, parseWalkthroughDocument } from "@startup/onboarding/walkthrough";

import { FAILURE_REASONS, formatDate, shortCommit, STATUS_LABELS } from "@/lib/repositories";

import { StatusRefresher } from "../status-refresher";
import { DeleteButton } from "./delete-button";
import { RetryButton } from "./retry-button";
import { Walkthrough } from "./walkthrough";

// The title never names a repository. See docs/architecture/observability.md.
// There is deliberately no loading.tsx: `notFound()` answers 404 only for a
// response that has not started streaming.
export const metadata: Metadata = { title: "Repository" };

export default async function RepositoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();

  if (!session) redirect(`/sign-in?redirect=${encodeURIComponent(`/repositories/${encodeURIComponent(id)}`)}`);

  let repository: RepositoryDetails;
  try {
    repository = await getRepository(session.user.id, id);
  } catch (error) {
    // Missing, another user's, and malformed IDs look the same.
    if (error instanceof RepositoryNotFoundError) notFound();
    throw error;
  }

  const { owner, name, status, commitSha: commit, coverage } = repository;
  const document = status === "done" ? parseWalkthroughDocument(repository.walkthrough) : null;
  const ranked = coverage ? coverage.listed - coverage.dropped - coverage.unscored : 0;

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href="/repositories" className="text-sm underline underline-offset-4">
          Repositories
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight break-all">
          {owner}/{name}
        </h1>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="font-medium">Status</dt>
        {/* Announced when a refresh changes it. */}
        <dd aria-live="polite">
          {STATUS_LABELS[status]}
          {status === "failed" && repository.failureReason && (
            <span className="block text-zinc-600 dark:text-zinc-400">{FAILURE_REASONS[repository.failureReason]}</span>
          )}
        </dd>
        <dt className="font-medium">Repository</dt>
        <dd>
          <a
            href={`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`}
            className="underline underline-offset-4"
          >
            View on GitHub
          </a>
        </dd>
        <dt className="font-medium">Commit</dt>
        <dd>
          <a href={githubUrl(owner, name, commit, "", "directory")} className="font-mono underline underline-offset-4">
            {shortCommit(commit)}
          </a>
        </dd>
        <dt className="font-medium">Added</dt>
        <dd>
          <time dateTime={repository.createdAt.toISOString()}>{formatDate(repository.createdAt)}</time>
        </dd>
        {repository.finishedAt && (
          <>
            <dt className="font-medium">Finished</dt>
            <dd>
              <time dateTime={repository.finishedAt.toISOString()}>{formatDate(repository.finishedAt)}</time>
            </dd>
          </>
        )}
      </dl>

      {coverage && (
        <section aria-labelledby="coverage" className="flex flex-col gap-3">
          <h2 id="coverage" className="text-lg font-medium">
            Coverage
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt>Files listed</dt>
            <dd>{coverage.listed}</dd>
            <dt>Dropped</dt>
            <dd>{coverage.dropped}</dd>
            <dt>Left unscored by the file limit</dt>
            <dd>{coverage.unscored}</dd>
            <dt>Ranked by local signals only</dt>
            <dd>{coverage.localOnly}</dd>
          </dl>
          {ranked > 0 && coverage.localOnly === ranked && (
            <p className="text-sm">
              Every file was ranked by local signals, such as its name and place in the tree, without a scoring model.
            </p>
          )}
        </section>
      )}

      {status === "queued" && (
        <p className="text-sm">The analysis is waiting to start. Your analyses run one at a time.</p>
      )}
      {status === "running" && <p className="text-sm">The analysis is running.</p>}
      {status === "done" &&
        (document ? (
          <Walkthrough document={document} target={{ owner, name, commit }} />
        ) : (
          <p className="text-sm">The walkthrough can&apos;t be shown.</p>
        ))}

      <div className="flex flex-col gap-4 border-t border-black/10 pt-6">
        {status === "failed" && <RetryButton id={repository.id} />}
        <DeleteButton id={repository.id} />
      </div>

      <StatusRefresher active={status === "queued" || status === "running"} />
    </>
  );
}
