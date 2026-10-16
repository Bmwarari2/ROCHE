"use client";

import { CircleCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";

/**
 * After an incident form saves (recording it, reviewing or closing it, or preparing, submitting
 * or deciding on a notification), its page opens with focus on its heading (WCAG 2.4.3), so
 * keyboard and screen reader users start at the top of what changed, and says in a polite status,
 * with an icon and words, what was done. With `param`, that query parameter is taken off the
 * address once said, so reloading or sharing the page does not say it again.
 */
export function RecordedArrival({
  message,
  param,
}: {
  readonly message?: string;
  /** The query parameter that brought the page here ("done"). */
  readonly param?: string;
}) {
  const words = message ?? t("safety.record.saved");
  // Each save adds `at`, so a second save with the same words is a new arrival (focus and status).
  const at = useSearchParams().get("at");
  const arrived = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the words and each arrival.
  useEffect(() => {
    // Taking the parameters off the address below changes `at` to null: not a new arrival.
    if (arrived.current && at === null) return;
    arrived.current = true;
    const heading = document.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus();
    }
    if (param) {
      const url = new URL(window.location.href);
      if (url.searchParams.has(param) || url.searchParams.has("at")) {
        url.searchParams.delete(param);
        url.searchParams.delete("at");
        window.history.replaceState(window.history.state, "", url);
      }
    }
  }, [words, param, at]);
  return (
    <div role="status">
      <p key={at ?? "first"} className="m-0 inline-flex items-center gap-2 font-semibold">
        <CircleCheck size={18} strokeWidth={1.5} aria-hidden="true" />
        {words}
      </p>
    </div>
  );
}
