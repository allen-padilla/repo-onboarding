"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";

import { Button, FormMessage } from "@startup/ui";

import { sendRepositoryRequest } from "@/lib/repositories";

interface State {
  error?: string;
}

export function RetryButton({ id }: { id: string }) {
  const router = useRouter();
  const [state, submit, pending] = useActionState(async (): Promise<State> => {
    const result = await sendRepositoryRequest(`/api/repositories/${id}/retry`, "POST");
    if (!result.ok) return { error: result.message };

    router.refresh();
    return {};
  }, {});

  return (
    <form action={submit} className="flex flex-col gap-4">
      <FormMessage tone="error">{state.error}</FormMessage>
      <Button type="submit" disabled={pending}>
        Retry analysis
      </Button>
    </form>
  );
}
