import { deleteRepository } from "@startup/onboarding";

import { authorize, rejection } from "@/lib/repository-routes";

// Deletes one of the user's repositories, in any status, and stops its
// analysis. See docs/specs/repo-onboarding-core.md.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const caller = await authorize(request);
  if ("response" in caller) return caller.response;

  const { id } = await params;

  try {
    await deleteRepository(caller.user.id, id);

    return new Response(null, { status: 204 });
  } catch (error) {
    const response = rejection(error);
    if (response) return response;
    throw error;
  }
}
