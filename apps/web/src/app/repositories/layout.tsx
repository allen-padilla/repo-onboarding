// Both repository pages. They show repository names, paths, and walkthrough
// text, which PostHog must not receive: autocapture and session replay skip
// everything inside `ph-no-capture`. Each page checks the session itself,
// because a layout does not know which page it wraps. See
// docs/architecture/observability.md.
export default function RepositoriesLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <main className="ph-no-capture flex flex-1 justify-center px-6 py-16 font-sans">
      <div className="flex w-full max-w-3xl flex-col gap-8">{children}</div>
    </main>
  );
}
