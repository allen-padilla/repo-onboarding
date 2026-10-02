"use client";

import { Button, FormMessage } from "@startup/ui";

// Shown inside the repositories layout, and so inside `ph-no-capture`, when a
// page or one of its refreshes fails. The server has already reported the
// error, and its message never reaches the browser.
export default function RepositoriesError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <FormMessage tone="error">Something went wrong. Please try again.</FormMessage>
      <Button type="button" variant="outline" onClick={() => retry()}>
        Try again
      </Button>
    </div>
  );
}
