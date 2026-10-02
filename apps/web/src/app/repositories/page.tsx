import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession } from "@startup/auth/next";
import { getAddStatus, listRepositories, type AddUnavailableReason } from "@startup/onboarding";
import { FormMessage } from "@startup/ui";

import { FAILURE_REASONS, formatDate, REQUEST_MESSAGES, shortCommit, STATUS_LABELS } from "@/lib/repositories";

import { AddRepositoryForm } from "./add-repository-form";
import { StatusRefresher } from "./status-refresher";

// The title never names a repository. See docs/architecture/observability.md.
export const metadata: Metadata = { title: "Repositories" };

export default async function RepositoriesPage() {
  const session = await getSession();

  if (!session) redirect(`/sign-in?redirect=${encodeURIComponent("/repositories")}`);

  const [repositories, status] = await Promise.all([
    listRepositories(session.user.id),
    getAddStatus(session.user),
  ]);
  const active = repositories.some((repository) => repository.status === "queued" || repository.status === "running");

  return (
    <>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
        <Link href="/account" className="text-sm underline underline-offset-4">
          Account
        </Link>
      </div>

      <section aria-labelledby="add" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="add" className="text-lg font-medium">
            Add a repository
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {status.used} of {status.limit} used
          </p>
        </div>
        {status.unavailable ? <AddUnavailable reason={status.unavailable} /> : <AddRepositoryForm />}
      </section>

      <section aria-labelledby="list" className="flex flex-col gap-4">
        <h2 id="list" className="text-lg font-medium">
          Your repositories
        </h2>
        {repositories.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No repositories yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-black/10 rounded-md border border-black/10">
            {repositories.map((repository) => (
              <li key={repository.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <Link
                    href={`/repositories/${repository.id}`}
                    className="font-medium break-all underline underline-offset-4"
                  >
                    {repository.owner}/{repository.name}
                  </Link>
                  <span>{STATUS_LABELS[repository.status]}</span>
                </div>
                <p className="text-zinc-600 dark:text-zinc-400">
                  Added <time dateTime={repository.createdAt.toISOString()}>{formatDate(repository.createdAt)}</time>
                  {repository.status === "done" && (
                    <>
                      {" "}
                      · Commit <code className="font-mono">{shortCommit(repository.commitSha)}</code>
                    </>
                  )}
                </p>
                {repository.status === "failed" && repository.failureReason && (
                  <p className="text-zinc-600 dark:text-zinc-400">{FAILURE_REASONS[repository.failureReason]}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <StatusRefresher active={active} />
    </>
  );
}

function AddUnavailable({ reason }: { reason: AddUnavailableReason }) {
  if (reason === "VERIFICATION_REQUIRED") {
    return (
      <FormMessage tone="info">
        {REQUEST_MESSAGES.VERIFICATION_REQUIRED}{" "}
        <Link href="/account" className="underline underline-offset-4">
          Go to your account
        </Link>
      </FormMessage>
    );
  }

  return <FormMessage tone="info">{REQUEST_MESSAGES[reason]}</FormMessage>;
}
