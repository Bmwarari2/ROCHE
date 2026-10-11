"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";

/**
 * What happened when a care record form was sent. A refusal is an alert that takes focus, so the
 * person hears it and the form keeps their answers; success is a polite status. Each has an icon
 * and words, never colour alone. Anything important also stays on the page (the saved entry
 * appears in the list).
 */
export function FormFeedback({
  result,
  success,
}: {
  readonly result: ActionResult<unknown> | null;
  /** "Note saved". */
  readonly success: string;
}) {
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result && !result.ok) alertRef.current?.focus();
  }, [result]);

  return (
    <>
      <div role="status" className="empty:hidden">
        {result?.ok ? (
          <p className="m-0 inline-flex items-center gap-2 font-semibold">
            <CircleCheck size={18} strokeWidth={1.5} aria-hidden="true" />
            {success}
          </p>
        ) : null}
      </div>
      {result && !result.ok ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="flex gap-3 rounded-input border-s-4 border-danger bg-bg-secondary p-4"
        >
          <CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="m-0 font-semibold">{t("care.common.problem")}</p>
            <p className="m-0">{result.message}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
