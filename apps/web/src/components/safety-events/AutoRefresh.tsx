"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Reads the page again from the API every minute while `active`, so a page left open never keeps
 * showing a police call as still due after its target has passed (HZ-127). Nothing on the page
 * moves or changes look except what the API says.
 */
export function AutoRefresh({
  active,
  everySeconds = 60,
}: {
  readonly active: boolean;
  readonly everySeconds?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), everySeconds * 1000);
    return () => window.clearInterval(timer);
  }, [active, everySeconds, router]);
  return null;
}
