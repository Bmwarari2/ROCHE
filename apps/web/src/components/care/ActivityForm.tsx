"use client";

import type { CreateActivityRecord } from "@harbour/contracts";
import { Button, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordActivity } from "@/app/actions/care-records";
import { readWholeNumber } from "@/lib/assessments";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors, partsFor, partsRefusal } from "@/lib/outcome";
import { readWhen } from "@/lib/uk-time";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds } from "./form-state";
import { WhenField } from "./WhenField";

type Attendance = CreateActivityRecord["attendance"];
type Engagement = NonNullable<CreateActivityRecord["engagement"]>;

const ATTENDANCE = [
  "attended",
  "partly_attended",
  "declined",
  "not_able",
] as const satisfies readonly Attendance[];
const ENGAGEMENT = [
  "engaged_throughout",
  "engaged_some_of_the_time",
  "engaged_briefly",
  "did_not_engage",
] as const satisfies readonly Engagement[];

const FIELDS = [
  "activity",
  "format",
  "attendance",
  "engagement",
  "durationMinutes",
  "notes",
  "occurredAt",
] as const;

/** Record an activity: what, group or one to one, whether the person took part and how (CARE-014). */
export function ActivityForm({
  personId,
  name,
}: {
  readonly personId: string;
  readonly name: string;
}) {
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();
  const tookPart = attendance === "attended" || attendance === "partly_attended";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const activity = String(form.get("activity") ?? "").trim();
    const format = form.get("format") === "group" ? "group" : "one_to_one";
    if (activity.length < 2 || !attendance) {
      setResult(
        fieldErrors({
          ...(activity.length < 2 ? { activity: t("care.activities.form.activityRequired") } : {}),
          ...(!attendance ? { attendance: t("care.activities.form.attendanceRequired") } : {}),
        }),
      );
      return;
    }
    const engagement = String(form.get("engagement") ?? "");
    const minutes = readWholeNumber(form.get("durationMinutes"));
    const when = readWhen(form, "occurredAt", t);
    if (!when.ok) {
      setResult(partsRefusal("occurredAt", when));
      return;
    }
    startTransition(async () => {
      const outcome = await recordActivity(personId, {
        id: entry.id,
        occurredAt: when.instant,
        sentAt: new Date().toISOString(),
        activity,
        format,
        attendance,
        notes: String(form.get("notes") ?? ""),
        ...(tookPart && engagement ? { engagement: engagement as Engagement } : {}),
        ...(minutes !== null ? { durationMinutes: minutes } : {}),
      });
      setResult(outcome);
      if (outcome.ok) {
        setRound((n) => n + 1);
        setAttendance(null);
        entry.next();
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          id={ids.activity}
          error={errorFor(result, "activity")}
          name="activity"
          label={t("care.activities.form.activity")}
          hint={t("care.activities.form.activityHint")}
          maxLength={120}
          className="max-w-md"
        />
        <RadioGroup
          id={ids.format}
          legend={t("care.activities.form.format")}
          name="format"
          layout="inline"
          defaultValue="group"
          options={(["group", "one_to_one"] as const).map((format) => ({
            value: format,
            label: t("care.activities.formatOption", { format }),
          }))}
        />
        <RadioGroup<Attendance>
          id={ids.attendance}
          error={errorFor(result, "attendance")}
          legend={t("care.activities.form.attendance", { name })}
          name="attendance"
          layout="inline"
          value={attendance}
          onValueChange={setAttendance}
          options={ATTENDANCE.map((value) => ({
            value,
            label: t("care.activities.attendanceOption", { attendance: value }),
          }))}
        />
        {tookPart ? (
          <RadioGroup<Engagement>
            id={ids.engagement}
            error={errorFor(result, "engagement")}
            legend={t("care.activities.form.engagement", { name })}
            name="engagement"
            layout="inline"
            options={ENGAGEMENT.map((value) => ({
              value,
              label: t("care.activities.engagementOption", { engagement: value }),
            }))}
          />
        ) : null}
        <TextField
          id={ids.durationMinutes}
          name="durationMinutes"
          label={t("care.activities.form.duration")}
          inputMode="numeric"
          autoComplete="off"
          className="max-w-xs"
        />
        <TextArea
          id={ids.notes}
          name="notes"
          label={t("care.activities.form.notes")}
          rows={2}
          maxLength={2000}
          formatCount={(remaining) => characterCount(remaining)}
        />
        <WhenField
          id={ids.occurredAt}
          error={errorFor(result, "occurredAt")}
          errorParts={partsFor(result, "occurredAt")}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.activities.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.activities.form.saved")} fieldIds={ids} />
    </div>
  );
}
