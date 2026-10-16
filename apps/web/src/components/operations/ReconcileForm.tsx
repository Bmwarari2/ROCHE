"use client";

import { Button, Checkbox, TextArea } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { reconcileOutage } from "@/app/actions/downtime";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { entryReference, type ReviewItem, reviewedEntryIds } from "@/lib/downtime";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";

const FIELDS = ["review", "statement"] as const;

/**
 * Confirm every paper record from the outage is entered and checked (operations.md rule 14 and
 * section 12, #38 review round 2). Each possible duplicate and each back-entry outside the window
 * with no reason is ticked as reviewed before anything is sent; the API refuses until they are,
 * and refuses anyone who entered or sent a paper record (H-203), in its own words.
 */
export function ReconcileForm({
  locationId,
  outageId,
  version,
  items,
}: {
  readonly locationId: string;
  readonly outageId: string;
  readonly version: number;
  readonly items: readonly ReviewItem[];
}) {
  const router = useRouter();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const itemId = (index: number) => (index === 0 ? ids.review : `${ids.review}-${index}`);
  const reviewError = errorFor(result, "review");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const statement = String(new FormData(event.currentTarget).get("statement") ?? "");
    const reviewed = reviewedEntryIds(items, ticked);
    const errors: Record<string, string> = {};
    if (reviewed === null) errors.review = t("operations.reconcile.reviewRequired");
    if (!statement.trim()) errors.statement = t("operations.reconcile.statementRequired");
    if (reviewed === null || !statement.trim()) {
      setResult(fieldErrors(errors));
      return;
    }
    startTransition(async () => {
      const outcome = await reconcileOutage(locationId, outageId, {
        statement,
        reviewedEntryIds: reviewed,
        version,
      });
      setResult(outcome);
      if (outcome.ok) {
        router.push(`/downtime/${locationId}/outages/${outageId}?done=reconciled`, {
          scroll: false,
        });
      }
    });
  };

  // The summary links to the first item still to tick.
  const firstUnticked = items.findIndex((item) => !ticked.has(item.key));
  const reviewIds = { ...ids, review: itemId(Math.max(firstUnticked, 0)) };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {items.length > 0 ? (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 font-semibold">{t("operations.reconcile.reviewLegend")}</legend>
          <p className="m-0 text-body-dense text-text-secondary">
            {t("operations.reconcile.reviewHint")}
          </p>
          {items.map((item, index) => (
            <Checkbox
              key={item.key}
              id={itemId(index)}
              name="reviewed"
              value={item.key}
              required
              checked={ticked.has(item.key)}
              onChange={(event) => {
                const next = new Set(ticked);
                if (event.currentTarget.checked) next.add(item.key);
                else next.delete(item.key);
                setTicked(next);
              }}
              label={t("operations.reconcile.item", {
                kind: item.kind,
                count: item.entryIds.length,
                refs: item.entryIds.map(entryReference).join(", "),
              })}
              {...(reviewError && !ticked.has(item.key) ? { error: reviewError } : {})}
            />
          ))}
        </fieldset>
      ) : null}
      <TextArea
        id={ids.statement}
        name="statement"
        label={t("operations.reconcile.statement")}
        hint={t("operations.reconcile.statementHint")}
        rows={4}
        required
        maxLength={2000}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "statement")}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {t("operations.reconcile.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("operations.outage.arrived", { done: "reconciled" })}
        fieldIds={reviewIds}
      />
    </form>
  );
}
