"use client";

import { Button, RadioGroup } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { recordIncidentDeathFacts } from "@/app/actions/incidents";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { readDeathFacts } from "@/lib/incident-forms";
import { type ActionResult, errorFor } from "@/lib/outcome";

const FIELDS = ["learningDisability", "autistic"] as const;

const choices = (["yes", "no", "not_known"] as const).map((answer) => ({
  value: answer,
  label: t("safety.questions.answer", { answer }),
}));

const asChoice = (value: boolean | null) => (value === null ? "not_known" : value ? "yes" : "no");

/**
 * Whether a person we support who died had a learning disability and whether they were autistic
 * (H-482, HZ-013), each yes, no or "Not known yet", answered from their record, for the person who
 * raised the incident or a holder of `safety.incident.manage`. Recording both does the Registered
 * Manager's task and lets LeDeR be decided from an answer; the incident cannot close until both are
 * recorded. Each answer starts at what is recorded.
 */
export function IncidentDeathFactsForm({
  incidentId,
  version,
  personRowId,
  name,
  learningDisability,
  autistic,
}: {
  readonly incidentId: string;
  readonly version: number;
  readonly personRowId: string;
  readonly name: string;
  readonly learningDisability: boolean | null;
  readonly autistic: boolean | null;
}) {
  const router = useRouter();
  const ids = useFieldIds(FIELDS);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const label = (field: string) => t("safety.record.label", { field });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readDeathFacts(new FormData(event.currentTarget), t);
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
      const outcome = await recordIncidentDeathFacts(incidentId, {
        personRowId,
        ...read.answers,
        version,
      });
      setResult(outcome);
      if (outcome.ok) router.refresh();
    });
  };

  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={submit}
      noValidate
      aria-label={t("safety.incident.deathFactsTitle", { name })}
    >
      <p className="m-0 max-w-prose">{t("safety.incident.deathFactsIntro", { name })}</p>
      <RadioGroup
        id={ids.learningDisability}
        name="learningDisability"
        legend={label("learningDisability")}
        hint={t("safety.record.hint", { field: "record" })}
        layout="inline"
        options={choices}
        defaultValue={asChoice(learningDisability)}
        required
        error={errorFor(result, "learningDisability")}
      />
      <RadioGroup
        id={ids.autistic}
        name="autistic"
        legend={label("autistic")}
        hint={t("safety.record.hint", { field: "record" })}
        layout="inline"
        options={choices}
        defaultValue={asChoice(autistic)}
        required
        error={errorFor(result, "autistic")}
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
