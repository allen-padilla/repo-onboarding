"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";

import { parseRepositoryUrl } from "@startup/github/url";
import { Button, FormMessage, Input, Label } from "@startup/ui";

import { REQUEST_MESSAGES, sendRepositoryRequest } from "@/lib/repositories";

interface State {
  url: string;
  error?: string;
  done?: boolean;
}

export function AddRepositoryForm() {
  const router = useRouter();
  const [state, submit, pending] = useActionState(
    async (_: State, form: FormData): Promise<State> => {
      const url = String(form.get("url") ?? "");

      // The server checks again. This only saves a request for a mistyped URL.
      if (!parseRepositoryUrl(url)) return { url, error: REQUEST_MESSAGES.INVALID_URL };

      const result = await sendRepositoryRequest("/api/repositories", "POST", { url });
      if (!result.ok) return { url, error: result.message };

      // A new repository, or the one the user already has.
      router.push(result.id ? `/repositories/${result.id}` : "/repositories");
      return { url, done: true };
    },
    { url: "" },
  );

  return (
    <form action={submit} className="flex flex-col gap-4">
      <FormMessage tone="error">{state.error}</FormMessage>
      <div className="flex flex-col gap-2">
        <Label htmlFor="url">Repository URL</Label>
        <Input
          id="url"
          name="url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://github.com/owner/repo"
          required
          defaultValue={state.url}
        />
      </div>
      <Button type="submit" disabled={pending || state.done}>
        Add repository
      </Button>
    </form>
  );
}
