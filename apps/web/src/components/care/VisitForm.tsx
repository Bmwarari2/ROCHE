"use client";

import type { CreateVisit } from "@harbour/contracts";
import { Button, DateTimeInput, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordVisit } from "@/app/actions/care-records";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { dateTimeLabels, readDateTimeField, readWhen } from "@/lib/uk-time";
import { FormFeedback } from "./FormFeedback";
import { WhenField } from "./WhenField";

type Kind = CreateVisit["kind"];

/**
 * Record a visit, a visit out or an accompanied appointment (Regulation 9A; register row
 * CARE-014). A restriction needs its reason every time; the API refuses one without.
 */
export function VisitForm({
  personId,
  name,
}: {
  readonly personId: string;
  readonly name: string;
}) {
  const [restricted, setRestricted] = useState<"yes" | "no">("no");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = String(form.get("kind") ?? "") as Kind | "";
    if (!kind) {
      setResult(refused(t("care.assessments.form.answerAll")));
      return;
    }
    const text = (field: string) => String(form.get(field) ?? "");
    const started = readWhen(form, "occurredAt", t, { subject: t("care.visits.startedSubject") });
    if (!started.ok) {
      setResult(refused(started.message));
      return;
    }
    const ended = readDateTimeField(form, "endedAt", {
      subject: t("care.visits.endedSubject"),
      optional: true,
      t,
    });
    if (!ended.ok) {
      setResult(refused(ended.message));
      return;
    }
    startTransition(async () => {
      const outcome = await recordVisit(personId, {
        kind,
        occurredAt: started.instant,
        sentAt: new Date().toISOString(),
        endedAt: ended.instant,
        visitorName: text("visitorName"),
        visitorRelationship: text("visitorRelationship"),
        restrictionsApplied: restricted === "yes",
        restrictionReason: restricted === "yes" ? text("restrictionReason") : "",
        notes: text("notes"),
      });
      setResult(outcome);
      if (outcome.ok) {
        setRound((n) => n + 1);
        setRestricted("no");
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <RadioGroup<Kind>
          legend={t("care.visits.form.kind")}
          name="kind"
          options={(["facilitated_visit", "visit_out", "accompaniment"] as const).map((kind) => ({
            value: kind,
            label: t("care.visits.kindOption", { kind, name }),
          }))}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField name="visitorName" label={t("care.visits.form.visitorName")} maxLength={200} />
          <TextField
            name="visitorRelationship"
            label={t("care.visits.form.relationship", { name })}
            maxLength={120}
          />
        </div>
        <WhenField legend={t("care.visits.form.started")} />
        <DateTimeInput
          legend={t("care.visits.form.ended")}
          hint={t("care.visits.form.endedHint")}
          name="endedAt"
          labels={dateTimeLabels(t)}
        />
        <RadioGroup<"yes" | "no">
          legend={t("care.visits.form.restrictions")}
          name="restrictionsApplied"
          layout="inline"
          value={restricted}
          onValueChange={setRestricted}
          options={[
            { value: "yes", label: t("care.common.yes") },
            { value: "no", label: t("care.common.no") },
          ]}
        />
        {restricted === "yes" ? (
          <TextArea
            name="restrictionReason"
            label={t("care.visits.form.restrictionReason")}
            hint={t("care.visits.form.restrictionHint")}
            rows={2}
            maxLength={1000}
            formatCount={(remaining) => characterCount(remaining)}
          />
        ) : null}
        <TextArea
          name="notes"
          label={t("care.visits.form.notes")}
          rows={2}
          maxLength={2000}
          formatCount={(remaining) => characterCount(remaining)}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.visits.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.visits.form.saved")} />
    </div>
  );
}
