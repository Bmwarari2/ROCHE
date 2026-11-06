"use client";

import { Button, TextArea } from "@harbour/ui";
import { Ban } from "lucide-react";
import { withdrawProtocol } from "@/app/actions/homely-remedies";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { protocolsHref, readWithdraw } from "@/lib/homely-remedies";
import { characterCount, t } from "@/lib/i18n";
import { errorFor } from "@/lib/outcome";
import { useArrival, useMedicineSubmit } from "../MedicineForms";

const FIELDS = ["reason"] as const;

/**
 * Withdrawing a homely remedy protocol with a reason, at the version read (slice 55; medicines.md
 * section 15.3): a withdrawn protocol is never used again and cannot be changed. Doses already given
 * under it stay on each person's record.
 */
export function WithdrawProtocolForm({
  locationId,
  protocolId,
  version,
}: {
  readonly locationId: string;
  readonly protocolId: string;
  readonly version: number;
}) {
  const ids = useFieldIds(FIELDS);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readWithdraw(form, t, version),
    (body) => withdrawProtocol(locationId, protocolId, body),
    () => arrive(protocolsHref(locationId), "withdrawn"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("medicines.homely.withdraw.reason")}
        hint={t("medicines.homely.withdraw.reasonHint")}
        rows={3}
        maxLength={500}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button
          type="submit"
          variant="destructive"
          icon={<Ban size={18} strokeWidth={1.5} aria-hidden="true" />}
          disabled={pending}
        >
          {pending ? t("common.saving") : t("medicines.homely.withdraw.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.homely.withdrawn")} fieldIds={ids} />
    </form>
  );
}
