"use client";

import type { AdvanceCareItem } from "@harbour/contracts";
import { Button, TextField } from "@harbour/ui";
import { CircleX } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { withdrawAdvanceCare } from "@/app/actions/care-records";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { useFieldIds, useInlineForm } from "./form-state";

const FIELDS = ["reason"] as const;

/**
 * Withdraw an advance care record, with the reason and by whom (CONTENT.md rule 4: a destructive
 * action names what it changes). Withdrawing a ReSPECT plan or DNACPR decision changes the CPR
 * status in the header (HZ-015), so the form says so before anything is sent. The record stays in
 * the history. Opening the form moves focus to the reason; Cancel puts it back on the button; once
 * withdrawn, the page says so and takes focus there, because this record is no longer in force.
 */
export function WithdrawAdvanceCare({
  personId,
  recordId,
  version,
  kind,
}: {
  readonly personId: string;
  readonly recordId: string;
  readonly version: number;
  readonly kind: AdvanceCareItem["kind"];
}) {
  const router = useRouter();
  const inline = useInlineForm<HTMLInputElement>();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const changesHeader = kind === "respect" || kind === "dnacpr";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    if (reason.trim().length < 3) {
      setResult(refused(t("care.advance.withdraw.reasonRequired"), "invalid", ["reason"]));
      return;
    }
    startTransition(async () => {
      const outcome = await withdrawAdvanceCare(personId, recordId, { reason, version });
      setResult(outcome);
      if (outcome.ok) {
        router.push(`/people/${personId}/advance-care?withdrawn=${kind}`, { scroll: false });
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <p className="m-0 font-semibold">
            {changesHeader
              ? t("care.advance.withdraw.consequenceCpr")
              : t("care.advance.withdraw.consequence")}
          </p>
          <TextField
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={t("care.advance.withdraw.reason")}
            maxLength={1000}
            error={errorFor(result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {t("care.advance.withdraw.submit", { kind })}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                inline.hide();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            ref={inline.trigger}
            variant="secondary"
            icon={<CircleX size={16} strokeWidth={1.5} />}
            onClick={() => {
              setResult(null);
              inline.show();
            }}
          >
            {t("care.advance.withdraw.open", { kind })}
          </Button>
        </div>
      )}
      <FormFeedback result={result} success={t("care.advance.withdraw.saved")} fieldIds={ids} />
    </div>
  );
}
