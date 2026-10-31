"use client";

import { Button, DateInput, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordCarePlanChange, recordReview } from "@/app/actions/reviews";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor, partsRefusal } from "@/lib/outcome";
import {
  CARE_PLAN_CHANGE_KINDS,
  FAMILY_INVOLVEMENT_KINDS,
  REVIEW_RECORD_KINDS,
  type ReviewRecordKind,
} from "@/lib/reviews";
import { dateBoxesOf, readDateField } from "@/lib/uk-time";

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

const REVIEW_FIELDS = [
  "kind",
  "heldOn",
  "participants",
  "familyInvolvementKind",
  "laReference",
  "outcome",
] as const;

/**
 * Record a review that was held (people.md rule 8; PEOP-008; HZ-008): a care plan review (which
 * covers every change waiting for review up to the day it was held), a local authority review, a
 * family involvement review or a trial placement's review. Who took part is asked by role, one
 * per line. The record is append-only; the API closes the open review task with it.
 */
export function ReviewForm({
  personId,
  today,
}: {
  readonly personId: string;
  readonly today: string;
}) {
  const [kind, setKind] = useState<ReviewRecordKind>("care_plan");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(REVIEW_FIELDS);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const held = readDateField(form, "heldOn", { subject: t("care.date.subject.heldOn"), t });
    if (!held.ok) {
      setResult(partsRefusal("heldOn", held));
      return;
    }
    startTransition(async () => {
      const outcome = await recordReview(personId, {
        kind,
        heldOn: held.date ?? "",
        participants: text("participants"),
        familyInvolvementKind: text("familyInvolvementKind"),
        laReference: text("laReference"),
        outcome: text("outcome"),
      });
      setResult(outcome);
      if (outcome.ok) {
        setRound((n) => n + 1);
        setKind("care_plan");
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
          label={t("people.reviews.form.kind")}
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value as ReviewRecordKind)}
          options={REVIEW_RECORD_KINDS.map((value) => ({
            value,
            label: t("people.reviews.recordKind", { kind: value }),
          }))}
          {...(kind === "care_plan" ? { hint: t("people.reviews.form.carePlanHint") } : {})}
          className="max-w-md"
        />
        <DateInput
          id={ids.heldOn}
          error={errorFor(result, "heldOn")}
          errorParts={dateBoxesOf(partsFor(result, "heldOn"))}
          legend={t("people.reviews.form.heldOn")}
          hint={t("care.date.hint")}
          name="heldOn"
          defaultValue={today}
          labels={dateLabels}
        />
        {kind === "family_involvement" ? (
          <RadioGroup
            id={ids.familyInvolvementKind}
            error={errorFor(result, "familyInvolvementKind")}
            legend={t("people.reviews.form.familyKind")}
            name="familyInvolvementKind"
            required
            options={FAMILY_INVOLVEMENT_KINDS.map((value) => ({
              value,
              label: t("people.reviews.familyKind", { kind: value }),
            }))}
          />
        ) : null}
        {kind === "la_review" ? (
          <TextField
            id={ids.laReference}
            error={errorFor(result, "laReference")}
            name="laReference"
            label={t("people.reviews.form.laReference")}
            maxLength={120}
            className="max-w-md"
          />
        ) : null}
        <TextArea
          id={ids.participants}
          error={errorFor(result, "participants")}
          name="participants"
          label={t("people.reviews.form.participants")}
          hint={t("people.reviews.form.participantsHint")}
          rows={3}
        />
        <TextArea
          id={ids.outcome}
          error={errorFor(result, "outcome")}
          name="outcome"
          label={t("people.reviews.form.outcome")}
          rows={3}
          maxLength={4000}
          formatCount={(remaining) => characterCount(remaining)}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("people.reviews.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("people.reviews.form.saved")} fieldIds={ids} />
    </div>
  );
}

const CHANGE_FIELDS = ["kind", "occurredOn"] as const;

/**
 * Record a change in need (people.md rule 8; HZ-008): it brings the care plan review forward, and
 * one review on change covers every change waiting for review.
 */
export function CarePlanChangeForm({
  personId,
  today,
}: {
  readonly personId: string;
  readonly today: string;
}) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(CHANGE_FIELDS);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const occurred = readDateField(form, "occurredOn", {
      subject: t("care.date.subject.occurredOn"),
      t,
    });
    if (!occurred.ok) {
      setResult(partsRefusal("occurredOn", occurred));
      return;
    }
    const kind = String(form.get("kind") ?? "");
    startTransition(async () => {
      const outcome = await recordCarePlanChange(personId, {
        kind,
        occurredOn: occurred.date ?? "",
      });
      setResult(outcome);
      if (outcome.ok) setRound((n) => n + 1);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <p className="m-0 max-w-prose">{t("people.reviews.change.hint")}</p>
        <SelectField
          id={ids.kind}
          error={errorFor(result, "kind")}
          name="kind"
          label={t("people.reviews.change.kind")}
          defaultValue="change_in_needs"
          options={CARE_PLAN_CHANGE_KINDS.map((value) => ({
            value,
            label: t("people.reviews.changeKind", { kind: value }),
          }))}
          className="max-w-md"
        />
        <DateInput
          id={ids.occurredOn}
          error={errorFor(result, "occurredOn")}
          errorParts={dateBoxesOf(partsFor(result, "occurredOn"))}
          legend={t("people.reviews.change.occurredOn")}
          hint={t("care.date.hint")}
          name="occurredOn"
          defaultValue={today}
          labels={dateLabels}
        />
        <div>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? t("common.saving") : t("people.reviews.change.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("people.reviews.change.saved")} fieldIds={ids} />
    </div>
  );
}
