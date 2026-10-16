"use client";

import { CircleCheck } from "lucide-react";
import { useEffect } from "react";
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the words, so a second action on the same page takes focus again.
  useEffect(() => {
    const heading = document.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus();
    }
    if (param) {
      const url = new URL(window.location.href);
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        window.history.replaceState(window.history.state, "", url);
      }
    }
  }, [words, param]);
  return (
    <div role="status">
      <p className="m-0 inline-flex items-center gap-2 font-semibold">
        <CircleCheck size={18} strokeWidth={1.5} aria-hidden="true" />
        {words}
      </p>
    </div>
  );
}
