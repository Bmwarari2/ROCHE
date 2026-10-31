"use client";

import { Button, DateTimeInput, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { CircleCheck, FilePlus, Save, Stethoscope } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  closeDeathRecord,
  openDeathRecord,
  recordDeathReview,
  recordDeathStep,
  recordJudgement,
} from "@/app/actions/deaths";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import {
  DEATH_NOTE_MAX,
  DEATH_REFERENCE_MAX,
  DEATH_REVIEW_MAX,
  type DeathStepKey,
  JUDGED_BY_MAX,
  readCloseDeath,
  readDeathReview,
  readDeathStep,
  readJudgement,
} from "@/lib/deaths";
import { uuidv7 } from "@/lib/entry-id";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import { boxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";
import { useSubmit } from "./use-submit";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const yesNo = (key: "deaths.judgement.expectedOption" | "deaths.judgement.unnaturalOption") => [
  { value: "yes", label: t(key, { answer: "yes" }) },
  { value: "no", label: t(key, { answer: "no" }) },
];

/** The clinician's judgement: never decided by Harbour, always with whose judgement it is. */
export function JudgementForm({
  id,
  version,
  expected,
  possiblyUnnatural,
  judgedBy,
}: {
  readonly id: string;
  readonly version: number;
  readonly expected: boolean | null;
  readonly possiblyUnnatural: boolean | null;
  readonly judgedBy: string | null;
}) {
  const ids = useFieldIds(["expected", "possiblyUnnatural", "judgedBy"]);
  const { submit, result, pending } = useSubmit(
    (form) => readJudgement(form, t, { version }),
    (body) => recordJudgement(id, body),
    undefined,
    t("deaths.judgement.done"),
  );
  const answer = (value: boolean | null) => (value === null ? undefined : value ? "yes" : "no");
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0">{t("deaths.judgement.intro")}</p>
      <RadioGroup
        id={ids.expected}
        name="expected"
        legend={t("deaths.judgement.expected")}
        options={yesNo("deaths.judgement.expectedOption")}
        {...(answer(expected) ? { defaultValue: answer(expected) } : {})}
        error={errorFor(result, "expected")}
      />
      <RadioGroup
        id={ids.possiblyUnnatural}
        name="possiblyUnnatural"
        legend={t("deaths.judgement.unnatural")}
        hint={t("deaths.judgement.unnaturalHint")}
        options={yesNo("deaths.judgement.unnaturalOption")}
        {...(answer(possiblyUnnatural) ? { defaultValue: answer(possiblyUnnatural) } : {})}
        error={errorFor(result, "possiblyUnnatural")}
      />
      <TextField
        id={ids.judgedBy}
        name="judgedBy"
        label={t("deaths.judgement.judgedBy")}
        hint={t("deaths.judgement.judgedByHint")}
        maxLength={JUDGED_BY_MAX}
        defaultValue={judgedBy ?? ""}
        autoComplete="off"
        error={errorFor(result, "judgedBy")}
      />
      <div>
        <Button type="submit" icon={<Stethoscope {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("deaths.judgement.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("deaths.judgement.done")} fieldIds={ids} />
    </form>
  );
}

/** Recording one step on the record as done, or not needed with the reason. */
export function DeathStepForm({ id, step }: { readonly id: string; readonly step: DeathStepKey }) {
  const ids = useFieldIds(["outcome", "at", "note", "reference"]);
  const { submit, result, pending } = useSubmit(
    (form) => readDeathStep(form, t, { id: uuidv7(), step }),
    (body) => recordDeathStep(id, body),
    undefined,
    t("deaths.step.done"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.outcome}
        name="outcome"
        legend={t("deaths.step.outcome")}
        options={[
          { value: "done", label: t("deaths.step.outcomeOption", { outcome: "done" }) },
          {
            value: "not_needed",
            label: t("deaths.step.outcomeOption", { outcome: "not_needed" }),
          },
        ]}
        error={errorFor(result, "outcome")}
      />
      <DateTimeInput
        id={ids.at}
        name="at"
        legend={t("deaths.step.at")}
        hint={t("care.when.hint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "at")}
        errorParts={boxesOf(partsFor(result, "at"))}
      />
      <TextArea
        id={ids.note}
        name="note"
        label={t("deaths.step.note")}
        hint={t("deaths.step.noteHint")}
        rows={2}
        maxLength={DEATH_NOTE_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "note")}
      />
      {step === "police_informed" ? (
        <TextField
          id={ids.reference}
          name="reference"
          label={t("deaths.step.reference")}
          maxLength={DEATH_REFERENCE_MAX}
          autoComplete="off"
          error={errorFor(result, "reference")}
        />
      ) : null}
      <div>
        <Button type="submit" variant="secondary" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("deaths.step.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("deaths.step.done")} fieldIds={ids} />
    </form>
  );
}

/** The mortality review: what was found and what is learnt. */
export function DeathReviewForm({
  id,
  version,
  findings,
  lessons,
}: {
  readonly id: string;
  readonly version: number;
  readonly findings: string | null;
  readonly lessons: string | null;
}) {
  const ids = useFieldIds(["findings", "lessons"]);
  const { submit, result, pending } = useSubmit(
    (form) => readDeathReview(form, t, { version }),
    (body) => recordDeathReview(id, body),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextArea
        id={ids.findings}
        name="findings"
        label={t("deaths.review.findings")}
        rows={4}
        maxLength={DEATH_REVIEW_MAX}
        defaultValue={findings ?? ""}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "findings")}
      />
      <TextArea
        id={ids.lessons}
        name="lessons"
        label={t("deaths.review.lessons")}
        rows={4}
        maxLength={DEATH_REVIEW_MAX}
        defaultValue={lessons ?? ""}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "lessons")}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("deaths.review.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("deaths.review.saved")} fieldIds={ids} />
    </form>
  );
}

/** Closing the record: final, and refused by the API while anything is outstanding. */
export function CloseDeathForm({ id, version }: { readonly id: string; readonly version: number }) {
  const { submit, result, pending } = useSubmit(
    () => readCloseDeath({ version }),
    (body) => closeDeathRecord(id, body),
    undefined,
    t("deaths.close.done"),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <p className="m-0">{t("deaths.close.final")}</p>
      <div>
        <Button
          type="submit"
          variant="secondary"
          icon={<CircleCheck {...icon} />}
          disabled={pending}
        >
          {pending ? t("common.saving") : t("deaths.close.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("deaths.close.done")} />
    </form>
  );
}

/** Opening the death record from the exit record that says the person died. */
export function OpenDeathForm({ exitRecordId }: { readonly exitRecordId: string }) {
  const router = useRouter();
  const { submit, result, pending } = useSubmit(
    () => ({ ok: true as const, body: exitRecordId }),
    openDeathRecord,
    (data) => {
      const opened = data as { id?: string };
      if (opened.id) router.push(`/deaths/${opened.id}`);
    },
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <div>
        <Button type="submit" icon={<FilePlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("deaths.new.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("deaths.new.done")} />
    </form>
  );
}
