"use client";

import { CircleCheck } from "lucide-react";
import { useEffect } from "react";
import { t } from "@/lib/i18n";

/**
 * After an incident form saves (recording it, reviewing or closing it, or preparing, submitting
 * or deciding on a notification), its page opens with focus on its heading (WCAG 2.4.3), so
 * keyboard and screen reader users start at the top of what changed, and says in a polite status,
 * with an icon and words, what was done.
 */
export function RecordedArrival({ message }: { readonly message?: string }) {
  useEffect(() => {
    const heading = document.querySelector("h1");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.focus();
  }, []);
  return (
    <div role="status">
      <p className="m-0 inline-flex items-center gap-2 font-semibold">
        <CircleCheck size={18} strokeWidth={1.5} aria-hidden="true" />
        {message ?? t("safety.record.saved")}
      </p>
    </div>
  );
}
