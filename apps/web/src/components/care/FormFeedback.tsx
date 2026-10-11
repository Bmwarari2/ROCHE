"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";

/** Moves focus to a field from the error summary and brings its question into view. */
function goToField(id: string) {
  const field = document.getElementById(id);
  if (!field) return;
  field.focus();
  const question = field.closest("fieldset") ?? field;
  question.scrollIntoView({ block: "center" });
}

/**
 * What happened when a care record form was sent (WCAG 3.3.1, 4.1.3 and 2.4.3).
 *
 * - A refusal is a summary that takes focus, so the person hears it, with a link to each field it
 *   is about; each field shows the same words beside it. The form keeps their answers.
 * - Success is a polite status. The status region is always on the page, empty until there is
 *   something to say, so screen readers announce it. Focus then moves to a stable place: the
 *   success message, or `focusOnSuccess` (for example the NEWS2 result, so its score and response
 *   are read out), never left on a form that has just been replaced.
 *
 * Each has an icon and words, never colour alone.
 */
export function FormFeedback({
  result,
  success,
  fieldIds = {},
  focusOnSuccess,
}: {
  readonly result: ActionResult<unknown> | null;
  /** "Note saved". */
  readonly success: string;
  /** Field key to the id of the field's input, for the links in the summary. */
  readonly fieldIds?: Readonly<Record<string, string>>;
  readonly focusOnSuccess?: RefObject<HTMLElement | null>;
}) {
  const alertRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!result) return;
    if (!result.ok) {
      alertRef.current?.focus();
      return;
    }
    (focusOnSuccess?.current ?? successRef.current)?.focus();
  }, [result, focusOnSuccess]);

  // One item per message, linked to the first field it is about that is on the page.
  const items: { message: string; id: string | null }[] = [];
  if (result && !result.ok && result.fields) {
    for (const [field, message] of Object.entries(result.fields)) {
      const fieldId = fieldIds[field];
      // A date field's error links to the first box it is about ("month", or the "fold" question).
      const part = result.parts?.[field]?.[0];
      const id = fieldId
        ? part && part !== "day" && part !== "mode"
          ? `${fieldId}-${part}`
          : fieldId
        : null;
      const item = items.find((existing) => existing.message === message);
      if (!item) items.push({ message, id });
      else if (item.id === null) item.id = id;
    }
  }

  return (
    <>
      <div role="status" className="m-0">
        {result?.ok ? (
          <p
            ref={successRef}
            tabIndex={-1}
            className="m-0 inline-flex items-center gap-2 font-semibold"
          >
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
            {items.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {items.map(({ message, id }) => (
                  <li key={message}>
                    {id ? (
                      <a
                        href={`#${id}`}
                        className="inline-flex min-h-target items-center underline"
                        onClick={(event) => {
                          event.preventDefault();
                          goToField(id);
                        }}
                      >
                        {message}
                      </a>
                    ) : (
                      message
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0">{result.message}</p>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
