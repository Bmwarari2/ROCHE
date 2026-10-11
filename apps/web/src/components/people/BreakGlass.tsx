"use client";

import { Button, buttonClassName, Sheet, SheetClose } from "@harbour/ui";
import { LockOpen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { type BreakGlassOutcome, openBreakGlass } from "@/app/actions/people";
import { BREAK_GLASS_MIN_LENGTH } from "@/lib/people";

export interface BreakGlassLabels {
  readonly title: string;
  readonly body: string;
  readonly justification: string;
  readonly cancel: string;
  readonly stepUpTitle: string;
  readonly stepUpBody: string;
}

const FAILURE: Record<Exclude<BreakGlassOutcome, { ok: true }>["reason"], string> = {
  "step-up": "",
  forbidden:
    "You do not have access to open records outside your access. Ask your manager if you need it.",
  "not-found": "We could not find a record with this address. Check the link and try again.",
  "too-short": `Explain why you need this record in ${BREAK_GLASS_MIN_LENGTH} characters or more.`,
  unavailable: "Harbour could not open the record just now. Try again in a moment.",
};

/**
 * "Open a record outside your access" (section 4): a typed reason of at least 20 characters. Only
 * rendered for people with people.person.break_glass; the API checks again and needs a fresh
 * sign-in.
 */
export function BreakGlass({
  personId,
  labels,
}: {
  readonly personId: string;
  readonly labels: BreakGlassLabels;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("justification") ?? "").trim();
    if (reason.length < BREAK_GLASS_MIN_LENGTH) {
      setError(FAILURE["too-short"]);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const outcome = await openBreakGlass(personId, reason);
      if (outcome.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      if (outcome.reason === "step-up") {
        setStepUp(true);
        return;
      }
      setError(FAILURE[outcome.reason]);
    } catch {
      setError(FAILURE.unavailable);
    } finally {
      setBusy(false);
    }
  };

  const signInAgain = `/sign-in?${new URLSearchParams({
    reason: "step-up",
    next: `/people/${personId}`,
  }).toString()}`;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setStepUp(false);
        }
      }}
      trigger={
        <Button variant="secondary" icon={<LockOpen size={18} strokeWidth={1.5} />}>
          {labels.title}
        </Button>
      }
      title={labels.title}
      description={labels.body}
    >
      {stepUp ? (
        <div role="alert" className="flex flex-col gap-4">
          <p className="m-0 font-semibold">{labels.stepUpTitle}</p>
          <p className="m-0">
            {labels.stepUpBody} You signed in a while ago, so Harbour needs you to sign in again
            before it opens a record outside your access.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={signInAgain} className={buttonClassName({ variant: "primary" })}>
              Sign in again
            </Link>
            <SheetClose asChild>
              <Button variant="secondary">{labels.cancel}</Button>
            </SheetClose>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className={`hb-field${error ? " hb-field--invalid" : ""}`}>
            <label htmlFor={fieldId} className="hb-field__label">
              {labels.justification}
            </label>
            <p id={`${fieldId}-hint`} className="hb-field__hint">
              At least {BREAK_GLASS_MIN_LENGTH} characters. It is recorded in the audit log with
              your name.
            </p>
            {error ? (
              <p id={`${fieldId}-error`} className="hb-field__error" role="alert">
                {error}
              </p>
            ) : null}
            <textarea
              id={fieldId}
              name="justification"
              rows={4}
              required
              minLength={BREAK_GLASS_MIN_LENGTH}
              maxLength={1000}
              className="hb-field__input resize-y"
              aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ""}`}
              aria-invalid={error ? true : undefined}
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <SheetClose asChild>
              <Button variant="secondary">{labels.cancel}</Button>
            </SheetClose>
            <Button type="submit" variant="destructive" disabled={busy}>
              Open record
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
