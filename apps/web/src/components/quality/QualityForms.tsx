"use client";

import { Button, Checkbox, TextArea } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { END_REASON_MAX, readEndReason } from "@/lib/evidence-packs";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, type FieldErrors, fieldErrors } from "@/lib/outcome";
import type { QualityDone } from "@/lib/quality-done";

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
        typeof done === "function"
          ? done(outcome.data)
          : `${path}${path.includes("?") ? "&" : "?"}done=${done}&at=${Date.now()}`;
      router.replace(target);
    });
  const fail = (errors: FieldErrors, parts?: Readonly<Record<string, readonly string[]>>) =>
    setResult({ ...fieldErrors(errors), ...(parts ? { parts } : {}) });
  return { result, setResult, pending, send, fail };
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
  confirm,
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
  /** A box that must be ticked first, for a step that cannot be undone. */
  readonly confirm?: string;
  readonly children?: ReactNode;
}) {
  const ids = useFieldIds(["reason", "confirm"]);
  const titleId = `${ids.reason}-title`;
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = readEndReason(data, t);
    const unconfirmed = confirm && data.get("confirm") !== "yes";
    if (!read.ok || unconfirmed) {
      return fail({
        ...(read.ok ? {} : read.errors),
        ...(unconfirmed ? { confirm: t("quality.end.confirmError") } : {}),
      });
    }
    send(done, () => onSend(read.reason));
  };
  const reasonError = errorFor(result, "reason");
  const confirmError = errorFor(result, "confirm");
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
        {confirm ? (
          <Checkbox
            id={ids.confirm}
            name="confirm"
            value="yes"
            label={confirm}
            required
            {...(confirmError ? { error: confirmError } : {})}
          />
        ) : null}
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
