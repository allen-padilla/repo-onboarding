import { retryAnalysis } from "@startup/onboarding";

import { authorize, rejection } from "@/lib/repository-routes";

// Starts a failed analysis again from the default branch's latest commit. See
// docs/specs/repo-onboarding-core.md.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const caller = await authorize(request);
  if ("response" in caller) return caller.response;

  const { id } = await params;

  try {
    const repository = await retryAnalysis(caller.user, id);

    return Response.json({ id: repository.id });
  } catch (error) {
    const response = rejection(error);
    if (response) return response;
    throw error;
  }
}
