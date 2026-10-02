import { addRepository } from "@startup/onboarding";

import { authorize, rejection } from "@/lib/repository-routes";

// Adds a public GitHub repository by URL and queues its analysis. `201` with
// the new repository's ID, or `200` with the ID of the one the user already
// has. See docs/specs/repo-onboarding-core.md.
export async function POST(request: Request) {
  const caller = await authorize(request);
  if ("response" in caller) return caller.response;

  const body: unknown = await request.json().catch(() => null);
  // Anything but a string is rejected as an invalid URL, and counts toward
  // the request limit like one.
  const url =
    typeof body === "object" && body !== null && "url" in body && typeof body.url === "string" ? body.url : "";

  try {
    const { repository, created } = await addRepository(caller.user, url);

    return Response.json({ id: repository.id }, { status: created ? 201 : 200 });
  } catch (error) {
    const response = rejection(error);
    if (response) return response;
    throw error;
  }
}
