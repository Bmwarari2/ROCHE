"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { DASHBOARD_REFRESH_MS } from "@/lib/dashboard";

/**
 * Reads the dashboard again every few minutes while it is in view, and as soon as it comes back
 * into view after longer than that, so counts on a page left open never read as current when they
 * are not (docs/specs/insights.md rule 8). The page says when they were worked out.
 */
export function DashboardRefresh({ readAt }: { readonly readAt: number }) {
  const router = useRouter();
  useEffect(() => {
    const stale = () => Date.now() - readAt >= DASHBOARD_REFRESH_MS;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && stale()) router.refresh();
    }, DASHBOARD_REFRESH_MS);
    const onShow = () => {
      if (document.visibilityState === "visible" && stale()) router.refresh();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [readAt, router]);
  return null;
}
