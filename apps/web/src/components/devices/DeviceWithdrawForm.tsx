"use client";

import type { DeviceRevocationReason } from "@harbour/contracts";
import { Button, Checkbox, RadioGroup } from "@harbour/ui";
import { useRouter } from "next/navigation";
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
 * Withdraws one Care mode phone (HZ-040, HZ-006): a coded reason, never words, and a tick that
 * says what happens and that it cannot be undone, including any entries waiting on it, which stay
 * there until handed over or deleted, their task due now. Nothing is chosen or ticked for the
 * manager. Entries the API heard about since the page loaded ask for the same tick again. On
 * success the page opens again at `done`, whose status takes focus (WCAG 4.1.3, 2.4.3).
 */
export function DeviceWithdrawForm({
  deviceId,
  entriesWaiting,
}: {
  readonly deviceId: string;
  readonly entriesWaiting: number;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [reason, setReason] = useState<DeviceRevocationReason | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const path = `/settings/devices/${deviceId}`;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    if (!reason) problems.push({ field: "reason", message: t("devices.withdraw.reasonRequired") });
    const confirmed = form.get("confirm") === "on";
    if (!confirmed) {
      problems.push({ field: "confirm", message: t("devices.withdraw.confirmRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !reason) {
      setResult(refusal);
      return;
    }
    startTransition(async () => {
      const outcome = await withdrawDevice(deviceId, {
        reasonCode: reason,
        confirmEntriesWaiting: confirmed,
      });
      setResult(outcome);
      if (outcome.ok) {
        const done = outcome.data.replay ? "already" : "withdrawn";
        router.replace(`${path}?done=${done}&at=${Date.now()}`);
      }
    });
  };

  if (result && !result.ok && result.code === "step_up_required") {
    return <StepUpNotice next={path} refusal={result} body={t("devices.withdraw.stepUp")} />;
  }

  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={submit}
      noValidate
      aria-busy={pending}
    >
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
      <Checkbox
        id={ids.confirm}
        name="confirm"
        error={errorFor(result, "confirm")}
        label={t("devices.withdraw.confirm", { count: entriesWaiting })}
      />
      <div>
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? t("devices.withdraw.sending") : t("devices.withdraw.submit")}
        </Button>
      </div>
      {result && !result.ok ? <FormFeedback result={result} success="" fieldIds={ids} /> : null}
    </form>
  );
}
