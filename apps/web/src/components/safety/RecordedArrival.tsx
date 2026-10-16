"use client";

import { CircleCheck } from "lucide-react";
import { useEffect } from "react";
import { t } from "@/lib/i18n";

/**
 * After the record an incident form saves, its page opens with focus on its heading (WCAG 2.4.3),
 * so keyboard and screen reader users start at the top of what they recorded, and says in a
 * polite status, with an icon and words, that it was recorded.
 */
export function RecordedArrival() {
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
        {t("safety.record.saved")}
      </p>
    </div>
  );
}
