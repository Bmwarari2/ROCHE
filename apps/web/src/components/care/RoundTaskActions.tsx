"use client";

import { Button, buttonClassName, TextField } from "@harbour/ui";
import { Check, CircleX, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { moveRoundTask } from "@/app/actions/round";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";
import type { RoundTaskActions as Actions } from "@/lib/round";
import { FormFeedback } from "./FormFeedback";
import { useFieldIds, useInlineForm } from "./form-state";

const FIELDS = ["reason"] as const;

/**
 * A task's actions on the round: start it, mark it done, or say it was not done and why. A task
 * that needs a record (a repositioning or fluid round) is done by recording it, so it links there
 * instead. Each button names its task, so a list of them reads clearly. The round opens again
 * saying what was done, with focus there; refusals are said in words at the task.
 */
export function RoundTaskActions({
  locationId,
  taskId,
  version,
  title,
  actions,
  recordHref,
  returnTo,
  name,
}: {
  readonly locationId: string;
  readonly taskId: string;
  readonly version: number;
  /** The task's title, for the buttons' names. */
  readonly title: string;
  readonly actions: Actions;
  /** Where the record that completes the task is made, when it needs one. */
  readonly recordHref: string | null;
  /** The round's address, to come back to with what was done said and focused. */
  readonly returnTo: string;
  /** Whose task it is, for the buttons' names; null for a task about no one person. */
  readonly name: string | null;
}) {
  const who = name ?? "none";
  const router = useRouter();
  const inline = useInlineForm<HTMLInputElement>();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);

  const move = (to: "in_progress" | "done" | "skipped", reason?: string) =>
    startTransition(async () => {
      const outcome = await moveRoundTask(locationId, taskId, {
        to,
        version,
        ...(reason ? { reason } : {}),
      });
      // On success the round opens again and its notice takes focus: nothing to say here.
      setResult(outcome.ok ? null : outcome);
      if (outcome.ok) {
        inline.hide();
        const sep = returnTo.includes("?") ? "&" : "?";
        router.push(`${returnTo}${sep}moved=${to}&at=${Date.now()}`, { scroll: false });
      }
    });

  const skip = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    if (reason.trim().length < 3) {
      setResult(refused(t("care.round.reasonRequired"), "invalid", ["reason"]));
      return;
    }
    move("skipped", reason);
  };

  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form className="flex flex-col gap-3" onSubmit={skip} noValidate>
          <TextField
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={t("care.round.reason", { title, name: who })}
            hint={t("care.round.reasonHint")}
            required
            maxLength={500}
            error={errorFor(result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {t("care.round.skipSubmit")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                inline.hide();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.start ? (
            <Button
              variant="secondary"
              icon={<Play size={16} strokeWidth={1.5} />}
              disabled={pending}
              aria-label={t("care.round.startNamed", { title, name: who })}
              onClick={() => move("in_progress")}
            >
              {t("care.round.start")}
            </Button>
          ) : null}
          {actions.done ? (
            <Button
              icon={<Check size={16} strokeWidth={1.5} />}
              disabled={pending}
              aria-label={t("care.round.doneNamed", { title, name: who })}
              onClick={() => move("done")}
            >
              {t("care.round.done")}
            </Button>
          ) : null}
          {actions.recordFirst && recordHref ? (
            <Link
              href={recordHref}
              className={buttonClassName({ variant: "primary" })}
              aria-label={t("care.round.recordNamed", { title, name: who })}
            >
              {t("care.round.record")}
            </Link>
          ) : null}
          {actions.skip ? (
            <Button
              ref={inline.trigger}
              variant="secondary"
              icon={<CircleX size={16} strokeWidth={1.5} />}
              aria-label={t("care.round.skipNamed", { title, name: who })}
              onClick={() => {
                setResult(null);
                inline.show();
              }}
            >
              {t("care.round.skip")}
            </Button>
          ) : null}
        </div>
      )}
      <FormFeedback result={result} success={t("care.round.moved")} fieldIds={ids} />
    </div>
  );
}
