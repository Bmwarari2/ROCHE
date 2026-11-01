"use client";

import { Button, RadioGroup } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { recordIncidentContacts } from "@/app/actions/incidents";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { readContactsAnswers } from "@/lib/incident-forms";
import { type ActionResult, errorFor } from "@/lib/outcome";

const FIELDS = ["emergencyServicesCalled", "gpContacted"] as const;

const choices = (["yes", "no", "not_known"] as const).map((answer) => ({
  value: answer,
  label: t("safety.questions.answer", { answer }),
}));

const asChoice = (value: boolean | null) => (value === null ? "not_known" : value ? "yes" : "no");

/**
 * Record what is now known about the emergency services and the GP, while either is still "Not
 * known yet" (H-264, HZ-090): the incident cannot close until both are answered, and the task to
 * find out is done once they are. Each answer starts at what is recorded.
 */
export function IncidentContactsForm({
  incidentId,
  version,
  emergencyServicesCalled,
  gpContacted,
}: {
  readonly incidentId: string;
  readonly version: number;
  readonly emergencyServicesCalled: boolean | null;
  readonly gpContacted: boolean | null;
}) {
  const router = useRouter();
  const ids = useFieldIds(FIELDS);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const label = (field: string) => t("safety.record.label", { field });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readContactsAnswers(new FormData(event.currentTarget), t);
    if (!read.ok) {
      setResult({
        ok: false,
        code: "invalid",
        message: Object.values(read.errors)[0] ?? "",
        fields: read.errors,
      });
      return;
    }
    startTransition(async () => {
      const outcome = await recordIncidentContacts(incidentId, { ...read.answers, version });
      setResult(outcome);
      if (outcome.ok) router.refresh();
    });
  };

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("safety.incident.contactsStillOpen")}</p>
      <RadioGroup
        id={ids.emergencyServicesCalled}
        name="emergencyServicesCalled"
        legend={label("emergencyServicesCalled")}
        hint={t("safety.record.hint", { field: "askFirst" })}
        layout="inline"
        options={choices}
        defaultValue={asChoice(emergencyServicesCalled)}
        required
        error={errorFor(result, "emergencyServicesCalled")}
      />
      <RadioGroup
        id={ids.gpContacted}
        name="gpContacted"
        legend={label("gpContacted")}
        hint={t("safety.record.hint", { field: "askFirst" })}
        layout="inline"
        options={choices}
        defaultValue={asChoice(gpContacted)}
        required
        error={errorFor(result, "gpContacted")}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("safety.incident.contactsSave")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("safety.incident.contactsSaved")} fieldIds={ids} />
    </form>
  );
}
