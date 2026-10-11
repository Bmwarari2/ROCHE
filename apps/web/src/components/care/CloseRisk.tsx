"use client";

import { Button, TextField } from "@harbour/ui";
import { CircleX } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { closeRiskAssessment } from "@/app/actions/care-plan";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";

/** Close a risk assessment that no longer applies, with the reason; it stays in the history. */
export function CloseRisk({
  personId,
  riskId,
  version,
}: {
  readonly personId: string;
  readonly riskId: string;
  readonly version: number;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    startTransition(async () => {
      setResult(await closeRiskAssessment(personId, riskId, { reason, version }));
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {open ? (
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <TextField name="reason" label={t("care.risk.close.reason")} maxLength={500} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {t("care.risk.close.submit")}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            variant="secondary"
            icon={<CircleX size={16} strokeWidth={1.5} />}
            onClick={() => {
              setResult(null);
              setOpen(true);
            }}
          >
            {t("care.risk.close.open")}
          </Button>
        </div>
      )}
      <FormFeedback result={result} success={t("care.risk.close.saved")} />
    </div>
  );
}
