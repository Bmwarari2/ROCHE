"use client";

import { Button, TextField } from "@harbour/ui";
import { CircleX } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { markHomelyDoseInError } from "@/app/actions/homely-remedies";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useEntryId, useFieldIds, useInlineForm } from "@/components/care/form-state";
import { personHomelyHref, readEnteredInError } from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";

const FIELDS = ["reason"] as const;

/**
 * Marking a homely remedy dose entered in error, with a reason (slice 55; medicines.md section
 * 15.3): a new record marks it, the dose stays struck through and no longer counts towards the
 * gap, the 24 hours or the course. The form opens in place; Cancel puts focus back on its button.
 * The same id goes with every attempt, so a resend marks it once.
 */
export function EnteredInErrorForm({
  personId,
  doseId,
  product,
}: {
  readonly personId: string;
  readonly doseId: string;
  readonly product: string;
}) {
  const router = useRouter();
  const inline = useInlineForm<HTMLInputElement>();
  const entry = useEntryId();
  const ids = useFieldIds(FIELDS);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readEnteredInError(new FormData(event.currentTarget), t, { id: entry.id });
    if (!read.ok) {
      setResult(fieldErrors(read.errors));
      return;
    }
    startTransition(async () => {
      const outcome = await markHomelyDoseInError(personId, doseId, read.body);
      setResult(outcome);
      if (outcome.ok) {
        router.push(`${personHomelyHref(personId)}?done=marked&at=${Date.now()}`);
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <p className="m-0 font-semibold">{t("medicines.homely.error.consequence")}</p>
          <TextField
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={t("medicines.homely.error.reason")}
            maxLength={500}
            error={errorFor(result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? t("common.saving") : t("medicines.homely.error.submit")}
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
            icon={<CircleX size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => {
              setResult(null);
              inline.show();
            }}
          >
            {t("medicines.homely.error.open", { product })}
          </Button>
        </div>
      )}
      <FormFeedback result={result} success={t("medicines.homely.error.done")} fieldIds={ids} />
    </div>
  );
}
