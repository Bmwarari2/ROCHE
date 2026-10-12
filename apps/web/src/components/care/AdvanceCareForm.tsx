"use client";

import type { CreateAdvanceCareRecord } from "@harbour/contracts";
import { Button, DateInput, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordAdvanceCare } from "@/app/actions/care-records";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor, partsRefusal } from "@/lib/outcome";
import { dateBoxesOf, readDateField } from "@/lib/uk-time";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds } from "./form-state";

type Kind = CreateAdvanceCareRecord["kind"];
type CprDecision = NonNullable<CreateAdvanceCareRecord["cprDecision"]>;

const KINDS = ["respect", "dnacpr", "adrt", "advance_care_plan"] as const satisfies readonly Kind[];

const FIELDS = [
  "kind",
  "cprDecision",
  "clinicianName",
  "clinicianRole",
  "completedOn",
  "reviewDueOn",
  "details",
] as const;

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

/**
 * Record a ReSPECT plan, DNACPR decision, ADRT or advance care plan (register row CARE-015;
 * hazard HZ-015). A ReSPECT plan carries the section 4 CPR recommendation; a DNACPR decision is
 * always do not attempt CPR. The header shows the decision in force as soon as it is saved.
 */
export function AdvanceCareForm({
  personId,
  today,
}: {
  readonly personId: string;
  readonly today: string;
}) {
  const [kind, setKind] = useState<Kind>("respect");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  // One client id per record, kept across retries, so a save sent twice records once (HZ-029).
  const entry = useEntryId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const decision = text("cprDecision") as CprDecision | "";
    const completed = readDateField(form, "completedOn", {
      subject: t("care.date.subject.completedOn"),
      t,
    });
    if (!completed.ok) {
      setResult(partsRefusal("completedOn", completed));
      return;
    }
    const review = readDateField(form, "reviewDueOn", {
      subject: t("care.date.subject.reviewDueOn"),
      optional: true,
      t,
    });
    if (!review.ok) {
      setResult(partsRefusal("reviewDueOn", review));
      return;
    }
    const input: CreateAdvanceCareRecord = {
      id: entry.id,
      kind,
      completedOn: completed.date ?? "",
      clinicianName: text("clinicianName"),
      clinicianRole: text("clinicianRole"),
      details: text("details"),
      ...(kind === "dnacpr"
        ? { cprDecision: "do_not_attempt_cpr" as const }
        : kind === "respect" && decision
          ? { cprDecision: decision }
          : {}),
      ...(review.date ? { reviewDueOn: review.date } : {}),
    };
    startTransition(async () => {
      const outcome = await recordAdvanceCare(personId, input);
      setResult(outcome);
      if (outcome.ok) {
        setRound((n) => n + 1);
        entry.next();
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <SelectField
          id={ids.kind}
          error={errorFor(result, "kind")}
          name="kind"
          label={t("care.advance.form.kind")}
          hint={t("care.advance.form.supersedes")}
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value as Kind)}
          options={KINDS.map((value) => ({
            value,
            label: t("care.advance.kind", { kind: value }),
          }))}
          className="max-w-md"
        />
        {kind === "respect" ? (
          <RadioGroup<CprDecision>
            id={ids.cprDecision}
            error={errorFor(result, "cprDecision")}
            legend={t("care.advance.form.cprDecision")}
            name="cprDecision"
            layout="inline"
            options={(["attempt_cpr", "do_not_attempt_cpr"] as const).map((decision) => ({
              value: decision,
              label: t("care.advance.cpr", { decision }),
            }))}
          />
        ) : null}
        {kind === "dnacpr" ? (
          <p className="m-0 font-semibold">{t("care.advance.form.dnacprNote")}</p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id={ids.clinicianName}
            error={errorFor(result, "clinicianName")}
            name="clinicianName"
            label={t("care.advance.form.clinicianName")}
            maxLength={200}
          />
          <TextField
            id={ids.clinicianRole}
            error={errorFor(result, "clinicianRole")}
            name="clinicianRole"
            label={t("care.advance.form.clinicianRole")}
            hint={t("care.advance.form.clinicianRoleHint")}
            maxLength={120}
          />
        </div>
        <DateInput
          id={ids.completedOn}
          error={errorFor(result, "completedOn")}
          errorParts={dateBoxesOf(partsFor(result, "completedOn"))}
          legend={t("care.advance.form.completedOn")}
          hint={t("care.date.hint")}
          name="completedOn"
          defaultValue={today}
          labels={dateLabels}
        />
        <DateInput
          id={ids.reviewDueOn}
          error={errorFor(result, "reviewDueOn")}
          errorParts={dateBoxesOf(partsFor(result, "reviewDueOn"))}
          legend={t("care.advance.form.reviewDueOn")}
          hint={t("care.date.hint")}
          name="reviewDueOn"
          labels={dateLabels}
        />
        <TextArea
          id={ids.details}
          name="details"
          label={t("care.advance.form.details")}
          rows={3}
          maxLength={4000}
          formatCount={(remaining) => characterCount(remaining)}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.advance.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.advance.form.saved")} fieldIds={ids} />
    </div>
  );
}
