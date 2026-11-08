"use client";

import type { DeviceRevocationReason } from "@harbour/contracts";
import { Button, Checkbox, RadioGroup } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { withdrawDevice } from "@/app/actions/care-devices";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { StepUpNotice } from "@/components/safety/ManageForms";
import { WITHDRAW_REASONS } from "@/lib/care-devices";
import { t } from "@/lib/i18n";
import { type ActionResult, collectedRefusal, errorFor, type FieldProblem } from "@/lib/outcome";

const FIELDS = ["reason", "confirm"] as const;

/**
 * Withdraws one Care mode phone (HZ-040, HZ-006): a coded reason, never words; and, when the phone
 * last reported entries waiting, the manager confirms they stay on it until handed over or
 * deleted and that its review falls due at once. Nothing is chosen or ticked for them. The API's
 * own refusal for entries it heard about since this page loaded asks for the same confirmation.
 */
export function DeviceWithdrawForm({
  deviceId,
  entriesWaiting,
}: {
  readonly deviceId: string;
  readonly entriesWaiting: number;
}) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [reason, setReason] = useState<DeviceRevocationReason | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  // Entries the API reported since the page loaded ask for the confirmation too.
  const askConfirm =
    entriesWaiting > 0 || (result?.ok === false && result.code === "entries_waiting");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    if (!reason) problems.push({ field: "reason", message: t("devices.withdraw.reasonRequired") });
    const confirmed = form.get("confirm") === "on";
    if (askConfirm && !confirmed) {
      problems.push({ field: "confirm", message: t("devices.withdraw.confirmRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !reason) {
      setResult(refusal);
      return;
    }
    startTransition(async () =>
      setResult(
        await withdrawDevice(deviceId, {
          reasonCode: reason,
          confirmEntriesWaiting: askConfirm && confirmed,
        }),
      ),
    );
  };

  if (result && !result.ok && result.code === "step_up_required") {
    return (
      <StepUpNotice
        next={`/settings/devices/${deviceId}`}
        refusal={result}
        body={t("devices.withdraw.stepUp")}
      />
    );
  }

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.reason}
        name="reason"
        legend={t("devices.withdraw.reason")}
        error={errorFor(result, "reason")}
        options={WITHDRAW_REASONS.map((value) => ({
          value,
          label: t("devices.reason", { reason: value }),
        }))}
        value={reason}
        onValueChange={setReason}
        required
      />
      {askConfirm ? (
        <Checkbox
          id={ids.confirm}
          name="confirm"
          error={errorFor(result, "confirm")}
          label={t("devices.withdraw.confirm", { count: entriesWaiting })}
        />
      ) : null}
      <div>
        <Button type="submit" variant="destructive" disabled={pending}>
          {t("devices.withdraw.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={
          result?.ok && (result.data as { replay?: boolean }).replay
            ? t("devices.withdraw.already")
            : t("devices.withdraw.done")
        }
        fieldIds={ids}
      />
    </form>
  );
}
