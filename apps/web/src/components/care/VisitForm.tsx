"use client";

import type { CreateVisit, OutageItem } from "@harbour/contracts";
import { Button, DateTimeInput, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordVisit } from "@/app/actions/care-records";
import { PAPER_FIELDS, readEntryWhen } from "@/lib/back-entry";
import { characterCount, t } from "@/lib/i18n";
import {
  type ActionResult,
  collectedRefusal,
  errorFor,
  partsFor,
  partsRefusal,
  refused,
} from "@/lib/outcome";
import { boxesOf, dateTimeLabels, readDateTimeField, ukRepeatedTime } from "@/lib/uk-time";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds } from "./form-state";
import { WhenField } from "./WhenField";

type Kind = CreateVisit["kind"];

const FIELDS = [
  "kind",
  "visitorName",
  "visitorRelationship",
  "occurredAt",
  "endedAt",
  "restrictionsApplied",
  "restrictionReason",
  "notes",
  ...PAPER_FIELDS,
] as const;

/**
 * Record a visit, a visit out or an accompanied appointment (Regulation 9A; register row
 * CARE-014). A restriction needs its reason every time; the API refuses one without, and the
 * refusal is shown at the reason.
 */
export function VisitForm({
  personId,
  outages = [],
  name,
}: {
  readonly personId: string;
  /** Outages a paper record can be entered against at the person's location. */
  readonly outages?: readonly OutageItem[];
  readonly name: string;
}) {
  const [restricted, setRestricted] = useState<"yes" | "no">("no");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = String(form.get("kind") ?? "") as Kind | "";
    if (!kind) {
      setResult(refused(t("care.visits.form.kindRequired"), "invalid", ["kind"]));
      return;
    }
    const text = (field: string) => String(form.get(field) ?? "");
    const started = readEntryWhen(form, "occurredAt", t, outages, {
      subject: t("care.visits.startedSubject"),
    });
    if (!started.ok) {
      setResult(collectedRefusal(started.problems));
      return;
    }
    const ended = readDateTimeField(form, "endedAt", {
      subject: t("care.visits.endedSubject"),
      optional: true,
      t,
    });
    if (!ended.ok) {
      setResult(partsRefusal("endedAt", ended));
      return;
    }
    startTransition(async () => {
      const outcome = await recordVisit(personId, {
        id: entry.id,
        kind,
        occurredAt: started.instant,
        downtime: started.downtime,
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
        entry.next();
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <RadioGroup<Kind>
          id={ids.kind}
          error={errorFor(result, "kind")}
          legend={t("care.visits.form.kind")}
          name="kind"
          options={(["facilitated_visit", "visit_out", "accompaniment"] as const).map((kind) => ({
            value: kind,
            label: t("care.visits.kindOption", { kind, name }),
          }))}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id={ids.visitorName}
            error={errorFor(result, "visitorName")}
            name="visitorName"
            label={t("care.visits.form.visitorName")}
            maxLength={200}
          />
          <TextField
            id={ids.visitorRelationship}
            name="visitorRelationship"
            label={t("care.visits.form.relationship", { name })}
            maxLength={120}
          />
        </div>
        <WhenField
          id={ids.occurredAt}
          legend={t("care.visits.form.started")}
          error={errorFor(result, "occurredAt")}
          errorParts={partsFor(result, "occurredAt")}
          paper={{ outages, ids, result }}
        />
        <DateTimeInput
          id={ids.endedAt}
          legend={t("care.visits.form.ended")}
          hint={t("care.visits.form.endedHint")}
          name="endedAt"
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          error={errorFor(result, "endedAt")}
          errorParts={boxesOf(partsFor(result, "endedAt"))}
        />
        <RadioGroup<"yes" | "no">
          id={ids.restrictionsApplied}
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
            id={ids.restrictionReason}
            error={errorFor(result, "restrictionReason")}
            name="restrictionReason"
            label={t("care.visits.form.restrictionReason")}
            hint={t("care.visits.form.restrictionHint")}
            rows={2}
            maxLength={1000}
            formatCount={(remaining) => characterCount(remaining)}
          />
        ) : null}
        <TextArea
          id={ids.notes}
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
      <FormFeedback result={result} success={t("care.visits.form.saved")} fieldIds={ids} />
    </div>
  );
}
