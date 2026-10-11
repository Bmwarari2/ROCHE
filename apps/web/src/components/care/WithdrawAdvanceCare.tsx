"use client";

import { Button, TextField } from "@harbour/ui";
import { CircleX } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { withdrawAdvanceCare } from "@/app/actions/care-records";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";

/** Withdraw an advance care record with the reason and by whom; it stays in the history. */
export function WithdrawAdvanceCare({
  personId,
  recordId,
  version,
}: {
  readonly personId: string;
  readonly recordId: string;
  readonly version: number;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    startTransition(async () => {
      setResult(await withdrawAdvanceCare(personId, recordId, { reason, version }));
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {open ? (
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <TextField name="reason" label={t("care.advance.withdraw.reason")} maxLength={1000} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {t("care.advance.withdraw.submit")}
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
            {t("care.advance.withdraw.open")}
          </Button>
        </div>
      )}
      <FormFeedback result={result} success={t("care.advance.withdraw.saved")} />
    </div>
  );
}
