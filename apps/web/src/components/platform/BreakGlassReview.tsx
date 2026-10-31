"use client";

import { Button, TextArea } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { reviewBreakGlassReport } from "@/app/actions/break-glass-report";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { ACTIONS_MAX, actionsProblem } from "@/lib/break-glass-report";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";

/**
 * Records the review of a weekly break-glass report with the actions taken (PLAT-006, HZ-011).
 * Offered once, to a reader the report does not flag; the API checks it all again. On success the
 * page opens again saying so, with focus on its heading (RecordedArrival).
 */
export function BreakGlassReview({
  reportId,
  path,
}: {
  readonly reportId: string;
  /** This report's address, opened again once the review is recorded. */
  readonly path: string;
}) {
  const ids = useFieldIds(["actionsTaken"]);
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const actionsTaken = String(new FormData(event.currentTarget).get("actionsTaken") ?? "");
    const problem = actionsProblem(actionsTaken);
    if (problem) {
      setResult(
        refused(t("breakGlassReport.review.problem", { problem, max: ACTIONS_MAX }), "invalid", [
          "actionsTaken",
        ]),
      );
      return;
    }
    startTransition(async () => {
      const outcome = await reviewBreakGlassReport(reportId, actionsTaken);
      setResult(outcome);
      if (outcome.ok) router.replace(`${path}&done=reviewed&at=${Date.now()}`, { scroll: false });
    });
  };
  const error = errorFor(result, "actionsTaken");

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextArea
          id={ids.actionsTaken}
          name="actionsTaken"
          label={t("breakGlassReport.review.label")}
          hint={t("breakGlassReport.review.hint")}
          rows={4}
          required
          maxLength={ACTIONS_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          {...(error ? { error } : {})}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("breakGlassReport.review.submit")}
          </Button>
        </div>
      </form>
      {result && !result.ok ? <FormFeedback result={result} success="" fieldIds={ids} /> : null}
    </div>
  );
}
