"use client";

import { Button, buttonClassName, Sheet, SheetClose, TextArea } from "@harbour/ui";
import { LockOpen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { type BreakGlassOutcome, openBreakGlass } from "@/app/actions/people";
import { characterCount } from "@/lib/i18n";
import { BREAK_GLASS_MAX_LENGTH, justificationProblem } from "@/lib/people";

type FailureReason = Exclude<Exclude<BreakGlassOutcome, { ok: true }>["reason"], "step-up">;

export interface BreakGlassLabels {
  readonly title: string;
  readonly body: string;
  readonly justification: string;
  readonly hint: string;
  readonly submit: string;
  readonly cancel: string;
  readonly close: string;
  readonly stepUpTitle: string;
  readonly stepUpBody: string;
  readonly stepUpReason: string;
  readonly signInAgain: string;
  /** What to do next for each way opening the record can fail. */
  readonly failure: Readonly<Record<FailureReason, string>>;
}

/**
 * "Open a record outside your access" (section 4): a typed reason of 20 to 1000 characters. Only
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // The message is part of the field's description, so moving focus to the field reads it out.
  const fail = (message: string) => {
    setError(message);
    requestAnimationFrame(() => fieldRef.current?.focus());
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("justification") ?? "").trim();
    const problem = justificationProblem(reason);
    if (problem) {
      fail(labels.failure[problem]);
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
      fail(labels.failure[outcome.reason]);
    } catch {
      fail(labels.failure.unavailable);
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
      closeLabel={labels.close}
    >
      {stepUp ? (
        <div role="alert" className="flex flex-col gap-4">
          <p className="m-0 font-semibold">{labels.stepUpTitle}</p>
          <p className="m-0">
            {labels.stepUpBody} {labels.stepUpReason}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={signInAgain} className={buttonClassName({ variant: "primary" })}>
              {labels.signInAgain}
            </Link>
            <SheetClose asChild>
              <Button variant="secondary">{labels.cancel}</Button>
            </SheetClose>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <TextArea
            ref={fieldRef}
            name="justification"
            label={labels.justification}
            hint={labels.hint}
            rows={4}
            required
            maxLength={BREAK_GLASS_MAX_LENGTH}
            formatCount={(remaining) => characterCount(remaining)}
            {...(error ? { error } : {})}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <SheetClose asChild>
              <Button variant="secondary">{labels.cancel}</Button>
            </SheetClose>
            <Button type="submit" variant="destructive" disabled={busy}>
              {labels.submit}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
