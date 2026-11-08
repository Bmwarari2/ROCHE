"use client";

import { Button, Checkbox, StatusChip, TextArea } from "@harbour/ui";
import { CircleCheck, FileText } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { type CdRecordingInput, setCdRecording } from "@/app/actions/cd-recording";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { StepUpNotice } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, collectedRefusal, errorFor, type FieldProblem } from "@/lib/outcome";

const FIELDS = ["closed", "carry", "phones", "reason", "restarted"] as const;

/**
 * Turns controlled drug recording on or off at one home (H-1517, H-1518; HZ-115, HZ-008). One
 * register is the record at a time, so each way asks the person to confirm the steps around it,
 * in words, before the API takes it; nothing is ticked for them. The state shows as an icon and a
 * word, never by colour alone.
 */
export function CdRecordingForm({
  locationId,
  enabled,
}: {
  readonly locationId: string;
  readonly enabled: boolean;
}) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    let input: CdRecordingInput;
    if (!enabled) {
      for (const field of ["closed", "carry", "phones"] as const) {
        if (form.get(field) !== "on") {
          problems.push({ field, message: t("medicines.cdRecording.confirmRequired", { field }) });
        }
      }
      input = { enabled: true, confirmed: problems.length === 0 };
    } else {
      const reason = String(form.get("reason") ?? "");
      if (!reason.trim()) {
        problems.push({ field: "reason", message: t("medicines.cdRecording.reasonRequired") });
      } else if (reason.trim().length > 2000) {
        problems.push({ field: "reason", message: t("medicines.cdRecording.reasonTooLong") });
      }
      if (form.get("restarted") !== "on") {
        problems.push({ field: "restarted", message: t("medicines.cdRecording.restartRequired") });
      }
      input = { enabled: false, reason, restarted: form.get("restarted") === "on" };
    }
    const refusal = collectedRefusal(problems);
    if (refusal) {
      setResult(refusal);
      return;
    }
    startTransition(async () => setResult(await setCdRecording(locationId, input)));
  };

  if (result && !result.ok && result.code === "step_up_required") {
    return (
      <StepUpNotice
        next={`/medicines-settings/${locationId}`}
        refusal={result}
        body={t("medicines.cdRecording.stepUp")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0">
        <StatusChip
          status={enabled ? "done" : "info"}
          label={t("medicines.cdRecording.state", { enabled: enabled ? "yes" : "no" })}
          icon={enabled ? CircleCheck : FileText}
        />
      </p>
      <p className="m-0">{t("medicines.cdRecording.about", { enabled: enabled ? "yes" : "no" })}</p>
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {enabled ? (
          <>
            <TextArea
              id={ids.reason}
              error={errorFor(result, "reason")}
              name="reason"
              label={t("medicines.cdRecording.reason")}
              hint={t("medicines.cdRecording.reasonHint")}
              rows={3}
              required
              maxLength={2000}
              formatCount={(remaining) => characterCount(remaining)}
            />
            <Checkbox
              id={ids.restarted}
              name="restarted"
              error={errorFor(result, "restarted")}
              label={t("medicines.cdRecording.restarted")}
            />
          </>
        ) : (
          <>
            <Checkbox
              id={ids.closed}
              name="closed"
              error={errorFor(result, "closed")}
              label={t("medicines.cdRecording.closed")}
            />
            <Checkbox
              id={ids.carry}
              name="carry"
              error={errorFor(result, "carry")}
              label={t("medicines.cdRecording.carry")}
            />
            <Checkbox
              id={ids.phones}
              name="phones"
              error={errorFor(result, "phones")}
              label={t("medicines.cdRecording.phones")}
            />
          </>
        )}
        <div>
          <Button type="submit" variant={enabled ? "destructive" : "primary"} disabled={pending}>
            {t("medicines.cdRecording.submit", { enabled: enabled ? "yes" : "no" })}
          </Button>
        </div>
        <FormFeedback
          result={result}
          success={
            result?.ok && !(result.data as { changed?: boolean }).changed
              ? t("medicines.cdRecording.unchanged")
              : t("medicines.cdRecording.done", {
                  enabled:
                    result?.ok && (result.data as { enabled?: boolean }).enabled ? "yes" : "no",
                })
          }
          fieldIds={ids}
        />
      </form>
    </div>
  );
}
