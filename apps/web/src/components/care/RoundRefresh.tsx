"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Reads the round again when a task's time state can next change, or after five minutes,
 * whichever is sooner (HZ-003), so a page left open never shows a task as still to come once it
 * is due or overdue. The page says when it was last read.
 */
export function RoundRefresh({ inMs }: { readonly inMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setTimeout(() => router.refresh(), inMs);
    return () => window.clearTimeout(timer);
  }, [inMs, router]);
  return null;
}
