"use client";

import { Button, TextArea } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { END_REASON_MAX, readEndReason } from "@/lib/evidence-packs";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, type FieldErrors, fieldErrors } from "@/lib/outcome";

/** What a quality form did, for the page's address: the page says it when it opens again. */
export const QUALITY_DONE = [
  "composed",
  "added",
  "redacted",
  "revoked",
  "discarded",
  "drafted",
  "saved",
  "approved",
  "sopDiscarded",
  "notified",
] as const;
export type QualityDone = (typeof QUALITY_DONE)[number];

/**
 * Sends one quality form and, on success, opens `path` again with `done`, which says what was done
 * and starts at its heading (RecordedArrival). A refusal is said in words; a step that needs
 * step-up asks for the passkey or authenticator code, with the way back.
 */
export function useQualitySend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = <T,>(
    done: QualityDone | ((data: T) => string),
    call: () => Promise<ActionResult<T>>,
  ) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (!outcome.ok) return;
      const target =
        typeof done === "function" ? done(outcome.data) : `${path}?done=${done}&at=${Date.now()}`;
      router.replace(target);
    });
  const fail = (errors: FieldErrors, parts?: Readonly<Record<string, readonly string[]>>) =>
    setResult({ ...fieldErrors(errors), ...(parts ? { parts } : {}) });
  return { result, setResult, pending, send, fail };
}

/** The `done` value from a page's address, when it is one of these. */
export function qualityDone(value: string | string[] | undefined): QualityDone | null {
  return typeof value === "string" && (QUALITY_DONE as readonly string[]).includes(value)
    ? (value as QualityDone)
    : null;
}

/** A refusal (a summary linked to its fields) or the step-up notice, after sending. */
export function QualityFeedback({
  result,
  path,
  fieldIds,
  stepUp,
}: {
  readonly result: ActionResult<unknown> | null;
  readonly path: string;
  readonly fieldIds?: Readonly<Record<string, string>>;
  readonly stepUp?: string;
}) {
  return (
    <ManageFeedback
      result={result}
      path={path}
      {...(fieldIds ? { fieldIds } : {})}
      {...(stepUp ? { stepUp } : {})}
    />
  );
}

/** A reason of 3 to 500 characters and one button: revoke or discard. */
export function QualityReasonForm({
  title,
  intro,
  label,
  hint,
  submit,
  path,
  done,
  onSend,
  children,
}: {
  readonly title: string;
  readonly intro: string;
  readonly label: string;
  readonly hint: string;
  readonly submit: string;
  readonly path: string;
  readonly done: QualityDone;
  readonly onSend: (reason: string) => Promise<ActionResult<unknown>>;
  readonly children?: ReactNode;
}) {
  const ids = useFieldIds(["reason"]);
  const titleId = `${ids.reason}-title`;
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readEndReason(new FormData(event.currentTarget), t);
    if (!read.ok) return fail(read.errors);
    send(done, () => onSend(read.reason));
  };
  const reasonError = errorFor(result, "reason");
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <div className="flex flex-col gap-1">
          <h3 id={titleId} className="m-0 text-body font-semibold">
            {title}
          </h3>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">{intro}</p>
        </div>
        {children}
        <TextArea
          id={ids.reason}
          name="reason"
          label={label}
          hint={hint}
          rows={3}
          required
          maxLength={END_REASON_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          {...(reasonError ? { error: reasonError } : {})}
        />
        <div>
          <Button type="submit" variant="destructive" disabled={pending}>
            {pending ? t("common.saving") : submit}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}
