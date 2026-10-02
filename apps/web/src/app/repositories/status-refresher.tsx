"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_MS = 3_000;

/**
 * Renders the page's server components again every 3 seconds while an
 * analysis is queued or running, so statuses update without a reload. A
 * hidden tab skips the refreshes and catches up when it is shown again.
 */
export function StatusRefresher({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;

    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active, router]);

  return null;
}
