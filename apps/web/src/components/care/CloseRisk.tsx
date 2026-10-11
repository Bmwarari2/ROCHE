"use client";

import { Button, TextField } from "@harbour/ui";
import { CircleX } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { closeRiskAssessment } from "@/app/actions/care-plan";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { useFieldIds, useInlineForm } from "./form-state";

const FIELDS = ["reason"] as const;

/**
 * Close a risk assessment that no longer applies, with the reason (CONTENT.md rule 4: a
 * destructive action names what it changes): it stops being in use and due for review, and its
 * controls are no longer shown as in place. It stays in the history. Opening the form moves focus
 * to the reason; Cancel puts it back on the button; once closed, the page says so and takes focus.
 */
export function CloseRisk({
  personId,
  riskId,
  version,
  title,
}: {
  readonly personId: string;
  readonly riskId: string;
  readonly version: number;
  /** The template's title, for example "Going out alone", so the button names the assessment. */
  readonly title: string;
}) {
  const router = useRouter();
  const inline = useInlineForm<HTMLInputElement>();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    if (reason.trim().length < 3) {
      setResult(refused(t("care.risk.close.reasonRequired"), "invalid", ["reason"]));
      return;
    }
    startTransition(async () => {
      const outcome = await closeRiskAssessment(personId, riskId, { reason, version });
      setResult(outcome);
      if (outcome.ok) {
        router.push(`/people/${personId}/risk-assessments?closed=${riskId}`, { scroll: false });
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <p className="m-0 font-semibold">{t("care.risk.close.consequence")}</p>
          <TextField
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={t("care.risk.close.reason")}
            maxLength={500}
            error={errorFor(result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {t("care.risk.close.submit", { title })}
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
            {t("care.risk.close.open", { title })}
          </Button>
        </div>
      )}
      <FormFeedback result={result} success={t("care.risk.close.saved")} fieldIds={ids} />
    </div>
  );
}
