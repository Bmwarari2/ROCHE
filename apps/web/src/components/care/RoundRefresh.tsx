"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isEditing, whenIdle } from "@/lib/round-editing";

/**
 * Reads the round again when a task's time state can next change, or after five minutes,
 * whichever is sooner (HZ-003), so a page left open never shows a task as still to come once it
 * is due or overdue. The page says when it was last read. While a "not done" reason is being
 * typed it waits, and reads again once the form is sent or closed, so the reason is never sent
 * against a task the carer has not seen, nor lost when the task leaves the list.
 */
export function RoundRefresh({ inMs }: { readonly inMs: number }) {
  const router = useRouter();
  useEffect(() => {
    let stopListening: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      if (!isEditing()) {
        router.refresh();
        return;
      }
      stopListening = whenIdle(() => {
        stopListening?.();
        router.refresh();
      });
    }, inMs);
    return () => {
      window.clearTimeout(timer);
      stopListening?.();
    };
  }, [inMs, router]);
  return null;
}
