"use client";

import { CLASSIFIER_QUESTIONS } from "@harbour/domain";
import { Button, RadioGroup, SelectField, TextArea } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { recordIncident } from "@/app/actions/incidents";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useEntryId, useFieldIds } from "@/components/care/form-state";
import { WhenField } from "@/components/care/WhenField";
import { characterCount, t } from "@/lib/i18n";
import {
  DESCRIPTION_MAX,
  HARM_GRADES,
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  NOTES_MAX,
  POINT_OF_CARE_QUESTIONS,
  questionField,
  readIncidentForm,
} from "@/lib/incident-forms";
import { type ActionResult, errorFor, partsFor } from "@/lib/outcome";
import { QuestionField } from "./QuestionField";

/** The point-of-care questions after a fall, from the domain's question set (HZ-027). */
const FALL_QUESTIONS = POINT_OF_CARE_QUESTIONS.map((key) => CLASSIFIER_QUESTIONS[key]);

const FIELDS = [
  "location",
  "type",
  "occurredAt",
  "description",
  "immediateActions",
  "severity",
  "harmGrade",
  "died",
  "injuryDetails",
  "emergencyServicesCalled",
  "gpContacted",
  "contactNotes",
  ...FALL_QUESTIONS.map((q) => questionField(q.key)),
] as const;

const label = (field: string) => t("safety.record.label", { field });
const yesNo = (["yes", "no"] as const).map((answer) => ({
  value: answer,
  label: t("safety.questions.answer", { answer }),
}));

/**
 * Record an incident or near miss (`safety.incident.report`; register row SAFE-001; hazards
 * HZ-013 and HZ-027). Started from a person's record it is about them, at their home; otherwise
 * the reporter chooses the location. Whether the emergency services were called, whether the GP
 * was contacted and whether the person died are asked every time, never assumed "no" (#42
 * review). A fall asks the point-of-care questions. The incident's UUIDv7 goes with every attempt,
 * so trying again after a lost connection never records it twice (HZ-029). Once recorded, the
 * incident's page opens, with the questions still to answer and the notifications' clocks.
 */
export function IncidentForm({
  locations,
  defaultLocationId,
  person,
  personNeeds,
}: {
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly defaultLocationId: string | null;
  /** The person it is about, from their record; their home is the location. */
  readonly person: { readonly id: string; readonly name: string } | null;
  /** Their communication needs, labelled, shown beside their name (Accessible Information Standard). */
  readonly personNeeds?: ReactNode;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [type, setType] = useState("");
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readIncidentForm(
      new FormData(event.currentTarget),
      {
        personId: person?.id ?? null,
        locationIds: locations.map((l) => l.id),
        fallQuestions: FALL_QUESTIONS,
        now: new Date(),
      },
      t,
    );
    if (!read.ok) {
      const first = Object.values(read.errors)[0] ?? "";
      setResult({
        ok: false,
        code: "invalid",
        message: first,
        fields: read.errors,
        ...(read.parts ? { parts: read.parts } : {}),
      });
      return;
    }
    startTransition(async () => {
      const outcome = await recordIncident({
        id: entry.id,
        sentAt: new Date().toISOString(),
        draft: read.draft,
      });
      setResult(outcome);
      // After an unknown outcome the id stays, so trying again returns the incident already
      // recorded instead of a second one.
      // The incident's page says it was recorded and moves focus to its heading.
      if (outcome.ok) router.push(`/incidents/${outcome.data.id}?recorded=1`);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {locations.length > 1 ? (
          <SelectField
            id={ids.location}
            name="location"
            label={label("location")}
            emptyOption={t("safety.record.choose", { field: "location" })}
            defaultValue={defaultLocationId ?? ""}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            className="max-w-sm"
            error={errorFor(result, "location")}
          />
        ) : null}
        <SelectField
          id={ids.type}
          name="type"
          label={label("type")}
          emptyOption={t("safety.record.choose", { field: "type" })}
          value={type}
          onChange={(event) => setType(event.currentTarget.value)}
          options={INCIDENT_TYPES.map((value) => ({
            value,
            label: t("safety.incident.type", { type: value }),
          }))}
          className="max-w-sm"
          error={errorFor(result, "type")}
        />
        <WhenField
          id={ids.occurredAt}
          legend={label("occurredAt")}
          explicit={{
            hint: t("safety.record.whenHint"),
            now: {
              label: t("safety.record.when", { when: "now" }),
              description: t("safety.record.whenDescription", { when: "now" }),
            },
            earlier: {
              label: t("safety.record.when", { when: "earlier" }),
              description: t("safety.record.whenDescription", { when: "earlier" }),
            },
          }}
          error={errorFor(result, "occurredAt")}
          errorParts={partsFor(result, "occurredAt")}
        />
        <TextArea
          id={ids.description}
          name="description"
          label={label("description")}
          hint={t("safety.record.hint", { field: "description" })}
          rows={5}
          required
          maxLength={DESCRIPTION_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "description")}
        />
        <TextArea
          id={ids.immediateActions}
          name="immediateActions"
          label={label("immediateActions")}
          rows={3}
          maxLength={DESCRIPTION_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "immediateActions")}
        />
        {type === "fall" ? (
          <fieldset className="m-0 flex flex-col gap-4 rounded-input border border-border p-4">
            <legend className="px-1 font-semibold">{t("safety.record.fall")}</legend>
            <p className="m-0 max-w-prose text-body-dense text-text-secondary">
              {t("safety.record.fallHint")}
            </p>
            {FALL_QUESTIONS.map((question) => {
              const field = questionField(question.key);
              return (
                <QuestionField
                  key={question.key}
                  question={question}
                  id={ids[field as keyof typeof ids] ?? field}
                  error={errorFor(result, field)}
                />
              );
            })}
          </fieldset>
        ) : null}
        {person ? (
          <fieldset className="m-0 flex flex-col gap-4 rounded-input border border-border p-4">
            <legend className="px-1 font-semibold">
              {t("safety.record.about", { name: person.name })}
            </legend>
            {personNeeds}
            <RadioGroup
              id={ids.died}
              name="died"
              legend={label("died")}
              hint={t("safety.record.hint", { field: "yesNo" })}
              layout="inline"
              options={yesNo}
              required
              error={errorFor(result, "died")}
            />
            <TextArea
              id={ids.injuryDetails}
              name="injuryDetails"
              label={label("injuryDetails")}
              hint={t("safety.record.hint", { field: "injuryDetails" })}
              rows={3}
              maxLength={NOTES_MAX}
              formatCount={(remaining) => characterCount(remaining)}
              error={errorFor(result, "injuryDetails")}
            />
          </fieldset>
        ) : null}
        <RadioGroup
          id={ids.emergencyServicesCalled}
          name="emergencyServicesCalled"
          legend={label("emergencyServicesCalled")}
          hint={t("safety.record.hint", { field: "askFirst" })}
          layout="inline"
          options={yesNo}
          required
          error={errorFor(result, "emergencyServicesCalled")}
        />
        <RadioGroup
          id={ids.gpContacted}
          name="gpContacted"
          legend={label("gpContacted")}
          hint={t("safety.record.hint", { field: "askFirst" })}
          layout="inline"
          options={yesNo}
          required
          error={errorFor(result, "gpContacted")}
        />
        <TextArea
          id={ids.contactNotes}
          name="contactNotes"
          label={label("contactNotes")}
          rows={3}
          maxLength={NOTES_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "contactNotes")}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            id={ids.severity}
            name="severity"
            label={label("severity")}
            hint={t("safety.record.hint", { field: "severity" })}
            emptyOption={t("safety.record.notJudged")}
            error={errorFor(result, "severity")}
            options={INCIDENT_SEVERITIES.map((value) => ({
              value,
              label: t("safety.incident.severity", { severity: value }),
            }))}
          />
          <SelectField
            id={ids.harmGrade}
            name="harmGrade"
            label={label("harmGrade")}
            hint={t("safety.record.hint", { field: "harmGrade" })}
            emptyOption={t("safety.record.notJudged")}
            error={errorFor(result, "harmGrade")}
            options={HARM_GRADES.map((value) => ({
              value,
              label: t("safety.incident.harm", { harm: value }),
            }))}
          />
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("safety.record.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("safety.record.saved")} fieldIds={ids} />
    </div>
  );
}
