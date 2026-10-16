"use client";

import { Button, buttonClassName, Checkbox, TextArea } from "@harbour/ui";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import { type ManageDone, manageResult, REASON_MAX, readReason } from "@/lib/incident-review";
import { type ActionResult, errorFor, type FieldErrors, fieldErrors } from "@/lib/outcome";

/**
 * "Confirm with your passkey or authenticator code", for a step that needs step-up (submitting a
 * statutory notification or deciding it is not required; section 5.3; a password sign-in alone
 * never counts, ADR-0072 amendment), as break-glass says it:
 * an alert that takes focus, with the link back to this page after signing in. What was typed is
 * not kept, and it says so.
 */
export function StepUpNotice({
  next,
  refusal,
}: {
  readonly next: string;
  /** The refusal shown; a new one (the same step refused again) takes focus again. */
  readonly refusal?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new refusal takes focus again.
  useEffect(() => ref.current?.focus(), [refusal]);
  const href = `/sign-in?${new URLSearchParams({ reason: "step-up", next }).toString()}`;
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="flex gap-3 rounded-input border-s-4 border-warning bg-bg-secondary p-4"
    >
      <ShieldCheck size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="flex flex-col gap-2">
        <p className="m-0 font-semibold">{t("auth.stepUp.title")}</p>
        <p className="m-0">{t("safety.manage.stepUp")}</p>
        <div>
          <Link href={href} className={buttonClassName({ variant: "primary" })}>
            {t("people.breakGlass.signInAgain")}
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Sends one of the manager's forms and, on success, opens the page again at `done`, which says
 * what was done and starts at its heading. A refusal is said in words a manager can act on; a
 * step that needs step-up asks for the passkey or authenticator code, with the way back.
 */
export function useManageSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (done: ManageDone, call: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = manageResult(await call(), t);
      setResult(outcome);
      // `at` makes each save a new arrival, so a second identical save is said and focused again.
      if (outcome.ok) router.replace(`${path}?done=${done}&at=${Date.now()}`);
    });
  /** Errors the form found before sending, with the date boxes each is about when it says. */
  const fail = (errors: FieldErrors, parts?: Readonly<Record<string, readonly string[]>>) =>
    setResult({ ...fieldErrors(errors), ...(parts ? { parts } : {}) });
  return { result, pending, send, fail };
}

/**
 * What a manager's form says after sending: a refusal (a summary that takes focus, linked to its
 * fields) or the step-up notice. Success says nothing here: the page opens again and its status
 * says what was done, with focus on its heading (RecordedArrival).
 */
export function ManageFeedback({
  result,
  path,
  fieldIds,
}: {
  readonly result: ActionResult<unknown> | null;
  readonly path: string;
  readonly fieldIds?: Readonly<Record<string, string>>;
}) {
  if (!result || result.ok) return null;
  if (result.code === "step_up_required") return <StepUpNotice next={path} refusal={result} />;
  return <FormFeedback result={result} success="" {...(fieldIds ? { fieldIds } : {})} />;
}

/**
 * A form that takes a reason of 3 to 1,000 characters and one button: send an incident back to
 * open, close it, or decide a notification is not required.
 */
export function ReasonForm({
  title,
  intro,
  label,
  hint,
  purpose,
  submit,
  path,
  done,
  onSend,
  destructive = false,
  min,
  confirm,
  children,
}: {
  readonly title: string;
  readonly intro?: string;
  readonly label: string;
  readonly hint: string;
  /** The `purpose` of the reason's error ("close", "reopen", "notRequired"). */
  readonly purpose: string;
  readonly submit: string;
  /** This page's path, to open again when it is done and to come back to after signing in. */
  readonly path: string;
  readonly done: ManageDone;
  readonly onSend: (reason: string) => Promise<ActionResult<unknown>>;
  readonly destructive?: boolean;
  /** The shortest reason taken, when more than 3 characters. */
  readonly min?: number;
  /** A box that must be ticked before sending, with the words that say what it confirms. */
  readonly confirm?: string;
  /** Shown between the title and the reason. */
  readonly children?: ReactNode;
}) {
  const ids = useFieldIds(["reason", "confirm"]);
  const titleId = `${ids.reason}-title`;
  const { result, pending, send, fail } = useManageSend(path);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readReason(new FormData(event.currentTarget), t, purpose, {
      ...(min ? { min } : {}),
      confirm: Boolean(confirm),
    });
    if (!read.ok) return fail(read.errors);
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
          {intro ? (
            <p className="m-0 max-w-prose text-body-dense text-text-secondary">{intro}</p>
          ) : null}
        </div>
        {children}
        <TextArea
          id={ids.reason}
          name="reason"
          label={label}
          hint={hint}
          rows={3}
          required
          maxLength={REASON_MAX}
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
          <Button
            type="submit"
            variant={destructive ? "destructive" : "primary"}
            disabled={pending}
          >
            {pending ? t("common.saving") : submit}
          </Button>
        </div>
      </form>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}
