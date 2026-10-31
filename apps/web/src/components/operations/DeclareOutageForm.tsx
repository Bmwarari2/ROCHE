"use client";

import type { OutageItem } from "@harbour/contracts";
import { Button, DateTimeInput, RadioGroup, TextArea } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { declareOutage } from "@/app/actions/downtime";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { OUTAGE_KINDS } from "@/lib/downtime";
import { characterCount, t } from "@/lib/i18n";
import {
  type ActionResult,
  collectedRefusal,
  errorFor,
  type FieldProblem,
  partsFor,
} from "@/lib/outcome";
import { boxesOf, dateTimeLabels, readDateTimeField, ukRepeatedTime } from "@/lib/uk-time";

type Kind = OutageItem["kind"];

const FIELDS = ["kind", "description", "startedAt", "endedAt"] as const;

/**
 * Declare an outage at a location (operations.md rule 9; HZ-017). Nothing is chosen for the
 * person: the kind and the start are asked for, never assumed to be now, and the end only when
 * systems are already back. The description reaches the carers assigned at the location, so it
 * asks for no names. Once declared, the outage's page says so and takes focus there.
 */
export function DeclareOutageForm({ locationId }: { readonly locationId: string }) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const kind = String(form.get("kind") ?? "") as Kind | "";
    if (!kind) problems.push({ field: "kind", message: t("operations.outage.form.kindRequired") });
    const description = String(form.get("description") ?? "");
    if (!description.trim()) {
      problems.push({
        field: "description",
        message: t("operations.outage.form.descriptionRequired"),
      });
    }
    const started = readDateTimeField(form, "startedAt", {
      subject: t("operations.outage.startSubject"),
      t,
    });
    if (!started.ok) {
      problems.push({ field: "startedAt", message: started.message, parts: started.parts });
    }
    const ended = readDateTimeField(form, "endedAt", {
      subject: t("operations.outage.endSubject"),
      optional: true,
      t,
    });
    if (!ended.ok) {
      problems.push({ field: "endedAt", message: ended.message, parts: ended.parts });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !kind || !started.ok || !ended.ok) {
      setResult(refusal);
      return;
    }
    startTransition(async () => {
      const outcome = await declareOutage(locationId, {
        kind,
        description,
        startedAt: started.instant ?? "",
        ...(ended.instant ? { endedAt: ended.instant } : {}),
      });
      setResult(outcome);
      if (outcome.ok) {
        router.push(`/downtime/${locationId}/outages/${outcome.data.id}?done=declared`);
      }
    });
  };

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup<Kind>
        id={ids.kind}
        error={errorFor(result, "kind")}
        legend={t("operations.outage.form.kind")}
        name="kind"
        required
        options={OUTAGE_KINDS.map((kind) => ({
          value: kind,
          label: t("operations.outage.kind", { kind }),
        }))}
      />
      <TextArea
        id={ids.description}
        error={errorFor(result, "description")}
        name="description"
        label={t("operations.outage.form.description")}
        hint={t("operations.outage.form.descriptionHint")}
        rows={3}
        required
        maxLength={1000}
        formatCount={(remaining) => characterCount(remaining)}
      />
      <DateTimeInput
        id={ids.startedAt}
        legend={t("operations.outage.form.started")}
        hint={t("care.when.hint")}
        name="startedAt"
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "startedAt")}
        errorParts={boxesOf(partsFor(result, "startedAt"))}
      />
      <DateTimeInput
        id={ids.endedAt}
        legend={t("operations.outage.form.ended")}
        hint={t("operations.outage.form.endedHint")}
        name="endedAt"
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "endedAt")}
        errorParts={boxesOf(partsFor(result, "endedAt"))}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {t("operations.outage.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("operations.outage.declared")} fieldIds={ids} />
    </form>
  );
}
