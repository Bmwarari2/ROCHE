"use client";

import { Button, DateInput, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { CalendarPlus, ClipboardCheck } from "lucide-react";
import { useState } from "react";
import { changeReview, scheduleReview } from "@/app/actions/medication-errors";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { useArrival, useMedicineSubmit } from "@/components/medicines/MedicineForms";
import { characterCount, t } from "@/lib/i18n";
import {
  CLINICIAN_NAME_MAX,
  OUTCOME_MAX,
  personReviewsHref,
  REASON_MAX,
  REVIEWER_ROLES,
  type Review,
  type ReviewChange,
  readCancelReview,
  readRescheduleReview,
  readReviewDone,
  readScheduleReview,
} from "@/lib/medication-errors";
import type { FormWithAll, Read } from "@/lib/medicines";
import { errorFor } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const count = (remaining: number) => characterCount(remaining);
const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

/**
 * Scheduling a medication review (slice 55; MEDS-013; medicines.md section 14.2; HZ-134): the date
 * it is due. The API refuses it for someone who has left or died, in words shown here.
 */
export function ScheduleReviewForm({ personId }: { readonly personId: string }) {
  const ids = useFieldIds(["dueOn"]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form: FormWithAll) => readScheduleReview(form, t),
    (body) => scheduleReview(personId, body),
    () => arrive(personReviewsHref(personId), "scheduled"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateInput
        id={ids.dueOn}
        name="dueOn"
        legend={t("medicines.errors.review.dueOn")}
        labels={dateLabels}
        error={errorFor(result, "dueOn")}
      />
      <div>
        <Button type="submit" icon={<CalendarPlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.errors.review.schedule")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("medicines.errors.review.done", { done: "scheduled" })}
        fieldIds={ids}
      />
    </form>
  );
}

type Action = "done" | "reschedule" | "cancel";

/**
 * Changing one review: a booked one is recorded as done, moved to another date or cancelled; one
 * already done is corrected. Each change other than recording it done needs a reason, kept in its
 * history. The outcome is the clinician's words; Harbour suggests nothing.
 */
export function ReviewChangeForm({
  personId,
  review,
}: {
  readonly personId: string;
  readonly review: Review;
}) {
  const ids = useFieldIds([
    "action",
    "doneOn",
    "clinicianName",
    "clinicianRole",
    "outcome",
    "correctionReason",
    "dueOn",
    "reason",
  ]);
  const arrive = useArrival();
  const correcting = review.doneOn !== null;
  const [action, setAction] = useState<Action | "">(correcting ? "done" : "");
  const { result, pending, submit } = useMedicineSubmit(
    (form: FormWithAll): Read<ReviewChange> => {
      if (action === "done") {
        const read = readReviewDone(form, t, { version: review.version, correcting });
        return read.ok ? { ok: true, body: { kind: "done", body: read.body } as const } : read;
      }
      if (action === "reschedule") {
        const read = readRescheduleReview(form, t, review.version);
        return read.ok
          ? { ok: true, body: { kind: "reschedule", body: read.body } as const }
          : read;
      }
      if (action === "cancel") {
        const read = readCancelReview(form, t, review.version);
        return read.ok ? { ok: true, body: { kind: "cancel", body: read.body } as const } : read;
      }
      return { ok: false, errors: { action: t("medicines.errors.review.actionError") } };
    },
    (change) => changeReview(personId, review.id, change),
    () =>
      arrive(
        personReviewsHref(personId),
        action === "done" ? (correcting ? "corrected" : "recorded") : action || "recorded",
      ),
  );
  const err = (name: string) => errorFor(result, name);
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {correcting ? (
        <p className="m-0 max-w-prose">{t("medicines.errors.review.correctIntro")}</p>
      ) : (
        <RadioGroup
          id={ids.action}
          name="action"
          legend={t("medicines.errors.review.action")}
          options={(["done", "reschedule", "cancel"] as const).map((a) => ({
            value: a,
            label: t("medicines.errors.review.actionOption", { action: a }),
          }))}
          onValueChange={(value) => setAction(value)}
          error={err("action")}
        />
      )}
      {action === "done" ? (
        <>
          <DateInput
            id={ids.doneOn}
            name="doneOn"
            legend={t("medicines.errors.review.doneOn")}
            labels={dateLabels}
            defaultValue={review.doneOn}
            error={err("doneOn")}
          />
          <TextField
            id={ids.clinicianName}
            name="clinicianName"
            label={t("medicines.errors.review.clinicianName")}
            maxLength={CLINICIAN_NAME_MAX}
            autoComplete="off"
            defaultValue={review.clinicianName ?? ""}
            error={err("clinicianName")}
          />
          <SelectField
            id={ids.clinicianRole}
            name="clinicianRole"
            label={t("medicines.errors.review.clinicianRole")}
            defaultValue={review.clinicianRole ?? ""}
            emptyOption={t("medicines.form.choose")}
            options={REVIEWER_ROLES.map((r) => ({
              value: r,
              label: t("medicines.errors.review.role", { role: r }),
            }))}
            error={err("clinicianRole")}
          />
          <TextArea
            id={ids.outcome}
            name="outcome"
            label={t("medicines.errors.review.outcome")}
            hint={t("medicines.errors.review.outcomeHint")}
            rows={4}
            maxLength={OUTCOME_MAX}
            formatCount={count}
            defaultValue={review.outcome ?? ""}
            error={err("outcome")}
          />
          {correcting ? (
            <TextArea
              id={ids.correctionReason}
              name="correctionReason"
              label={t("medicines.errors.review.correctionReason")}
              rows={2}
              maxLength={REASON_MAX}
              formatCount={count}
              error={err("correctionReason")}
            />
          ) : null}
        </>
      ) : null}
      {action === "reschedule" ? (
        <DateInput
          id={ids.dueOn}
          name="dueOn"
          legend={t("medicines.errors.review.newDueOn")}
          labels={dateLabels}
          defaultValue={review.dueOn}
          error={err("dueOn")}
        />
      ) : null}
      {action === "reschedule" || action === "cancel" ? (
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("medicines.errors.review.reason", { action })}
          rows={2}
          maxLength={REASON_MAX}
          formatCount={count}
          error={err("reason")}
        />
      ) : null}
      <div>
        <Button
          type="submit"
          variant={action === "cancel" ? "destructive" : "primary"}
          icon={<ClipboardCheck {...icon} />}
          disabled={pending}
        >
          {pending
            ? t("common.saving")
            : t("medicines.errors.review.submit", {
                action: correcting ? "correct" : action || "none",
              })}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("medicines.errors.review.done", {
          done: correcting ? "corrected" : action || "recorded",
        })}
        fieldIds={ids}
      />
    </form>
  );
}
