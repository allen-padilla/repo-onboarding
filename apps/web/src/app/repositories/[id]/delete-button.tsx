"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import { Button, FormMessage } from "@startup/ui";

import { sendRepositoryRequest } from "@/lib/repositories";

interface State {
  error?: string;
  done?: boolean;
}

/** Deletes the repository after the user confirms. */
export function DeleteButton({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, submit, pending] = useActionState(async (): Promise<State> => {
    const result = await sendRepositoryRequest(`/api/repositories/${id}`, "DELETE");
    if (!result.ok) return { error: result.message };

    router.replace("/repositories");
    return { done: true };
  }, {});

  if (!confirming) {
    return (
      <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
        Delete repository
      </Button>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <FormMessage tone="error">{state.error}</FormMessage>
      <p className="text-sm">Delete this repository and its walkthrough? Its analysis is stopped if it is still running.</p>
      <div className="flex gap-3">
        <Button type="submit" disabled={pending || state.done}>
          Delete
        </Button>
        {/* Focus moves here when the question appears, not to the destructive action. */}
        <Button
          type="button"
          variant="ghost"
          autoFocus
          disabled={pending || state.done}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
