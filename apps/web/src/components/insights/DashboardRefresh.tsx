"use client";

import { Button } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { DASHBOARD_REFRESH_MS } from "@/lib/dashboard";

/**
 * Keeps the counts honest without a timer (docs/specs/insights.md rule 8): the page says when they
 * were worked out, reads them again when the person comes back to the tab after longer than a few
 * minutes, and offers a button to read them now. No background timer, so a page left open neither
 * keeps the session alive nor fills the audit log (security review F2, F3), and nothing moves
 * on its own (WCAG 2.2.2). The update is silent, never announced.
 */
export function DashboardRefresh({
  readAt,
  label,
}: {
  readonly readAt: number;
  readonly label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === "visible" && Date.now() - readAt >= DASHBOARD_REFRESH_MS) {
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [readAt, router]);
  return (
    <div>
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        {label}
      </Button>
    </div>
  );
}
