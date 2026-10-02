import {
  githubUrl,
  type PathKind,
  type WalkthroughDocument,
  type WalkthroughParagraph,
} from "@startup/onboarding/walkthrough";

import { ROLE_LABELS } from "@/lib/repositories";

// Renders a stored walkthrough as React text and links. Model output and
// repository text are untrusted: nothing here renders HTML from the document,
// and every link is built by `githubUrl` from a path the analysis kept, at the
// analyzed commit. See docs/specs/repo-onboarding-core.md.

interface Target {
  readonly owner: string;
  readonly name: string;
  readonly commit: string;
}

export function Walkthrough({ document, target }: { document: WalkthroughDocument; target: Target }) {
  return (
    <div className="flex flex-col gap-8">
      {document.kind === "basic" && (
        <p className="rounded-md border border-black/10 bg-black/5 px-3 py-2 text-sm">
          No writing model is configured on this server, so this walkthrough has no written explanations.
        </p>
      )}

      <section aria-labelledby="summary" className="flex flex-col gap-3">
        <h2 id="summary" className="text-lg font-medium">
          What the project is
        </h2>
        {document.summary.map((paragraph, index) => (
          <Paragraph key={index} paragraph={paragraph} target={target} />
        ))}
      </section>

      <section aria-labelledby="organization" className="flex flex-col gap-3">
        <h2 id="organization" className="text-lg font-medium">
          How it is organized
        </h2>
        {document.directories.length === 0 ? (
          <p className="text-sm">Every file is at the top level.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {document.directories.map((directory, index) => (
              <li key={index} className="flex flex-col gap-1">
                <h3 className="font-medium">
                  {directory.heading.type === "path" ? (
                    <PathLink path={directory.heading.path} kind="directory" text={directory.heading.text} target={target} />
                  ) : (
                    directory.heading.text
                  )}
                </h3>
                <Paragraph paragraph={directory.description} target={target} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="key-files" className="flex flex-col gap-3">
        <h2 id="key-files" className="text-lg font-medium">
          Key files
        </h2>
        <ul className="flex flex-col gap-3">
          {document.keyFiles.map((file, index) => (
            <li key={index} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <PathLink path={file.path} kind="file" text={file.path} target={target} />
                <span className="text-sm text-zinc-600 dark:text-zinc-400">{ROLE_LABELS[file.role]}</span>
              </div>
              <Paragraph paragraph={file.why} target={target} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="reading-order" className="flex flex-col gap-3">
        <h2 id="reading-order" className="text-lg font-medium">
          Suggested reading order
        </h2>
        <ol className="flex list-decimal flex-col gap-3 pl-6">
          {document.readingOrder.map((step, index) => (
            <li key={index}>
              <PathLink path={step.path} kind="file" text={step.path} target={target} />
              <Paragraph paragraph={step.note} target={target} />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Paragraph({ paragraph, target }: { paragraph: WalkthroughParagraph; target: Target }) {
  if (paragraph.length === 0) return null;

  return (
    <p className="text-sm leading-6">
      {paragraph.map((segment, index) => {
        switch (segment.type) {
          case "text":
            return <span key={index}>{segment.text}</span>;
          case "code":
            return (
              <code key={index} className="font-mono">
                {segment.text}
              </code>
            );
          case "path":
            return <PathLink key={index} path={segment.path} kind={segment.kind} text={segment.text} target={target} />;
        }
      })}
    </p>
  );
}

function PathLink({ path, kind, text, target }: { path: string; kind: PathKind; text: string; target: Target }) {
  let href: string;
  try {
    href = githubUrl(target.owner, target.name, target.commit, path, kind);
  } catch {
    // Never a link that could leave the repository.
    return <code className="font-mono break-all">{text}</code>;
  }

  return (
    <a href={href} className="font-mono break-all underline underline-offset-4">
      {text}
    </a>
  );
}
