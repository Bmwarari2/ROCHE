"use client";

import type { CreateActivityRecord } from "@harbour/contracts";
import { Button, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordActivity } from "@/app/actions/care-records";
import { readWholeNumber } from "@/lib/assessments";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
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

/** Record an activity: what, group or one to one, whether the person took part and how (CARE-014). */
export function ActivityForm({
  personId,
  nowLocal,
  name,
}: {
  readonly personId: string;
  readonly nowLocal: string;
  readonly name: string;
}) {
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const tookPart = attendance === "attended" || attendance === "partly_attended";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const activity = String(form.get("activity") ?? "").trim();
    const format = form.get("format") === "group" ? "group" : "one_to_one";
    if (activity.length < 2 || !attendance) {
      setResult(refused(t("care.assessments.form.answerAll")));
      return;
    }
    const engagement = String(form.get("engagement") ?? "");
    const minutes = readWholeNumber(form.get("durationMinutes"));
    startTransition(async () => {
      const outcome = await recordActivity(personId, {
        occurredAtLocal: String(form.get("occurredAt") ?? ""),
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
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          name="activity"
          label={t("care.activities.form.activity")}
          hint={t("care.activities.form.activityHint")}
          maxLength={120}
          className="max-w-md"
        />
        <RadioGroup
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
          name="durationMinutes"
          label={t("care.activities.form.duration")}
          inputMode="numeric"
          autoComplete="off"
          className="max-w-xs"
        />
        <TextArea
          name="notes"
          label={t("care.activities.form.notes")}
          rows={2}
          maxLength={2000}
          formatCount={(remaining) => characterCount(remaining)}
        />
        <WhenField defaultValue={nowLocal} />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.activities.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.activities.form.saved")} />
    </div>
  );
}
