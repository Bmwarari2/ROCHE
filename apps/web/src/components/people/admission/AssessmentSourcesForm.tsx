"use client";

import { Button, Checkbox, RadioGroup, TextArea } from "@harbour/ui";
import { PencilLine } from "lucide-react";
import { type FormEvent, useState } from "react";
import { saveAssessmentSources } from "@/app/actions/admission";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, fieldErrors } from "@/lib/outcome";
import { useActionForm } from "./action-form";

export const INFORMATION_SOURCES = [
  "person",
  "family_or_representative",
  "hospital",
  "gp",
  "social_worker",
  "previous_provider",
  "other",
] as const;

const FIELDS = ["informationSources", "involved", "involvementReason"] as const;

/**
 * Who the information came from (at least one), and how the person took part in their own
 * assessment or why they could not (Regulation 9; people.md rule 4).
 */
export function AssessmentSourcesForm({
  personId,
  version,
  sources,
  involved,
  reason,
}: {
  readonly personId: string;
  readonly version: number;
  readonly sources: readonly string[];
  readonly involved: boolean | null;
  readonly reason: string | null;
}) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLElement>();
  const ids = useFieldIds(FIELDS);
  const [answer, setAnswer] = useState<"yes" | "no" | null>(
    involved === null ? null : involved ? "yes" : "no",
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const chosen = data.getAll("informationSources").map(String);
    const why = String(data.get("involvementReason") ?? "");
    const problems: Record<string, string> = {};
    if (chosen.length === 0) {
      problems.informationSources = t("people.preAdmission.sources.required");
    }
    if (!answer) problems.involved = t("people.preAdmission.involvement.required");
    if (answer === "no" && why.trim().length < 3) {
      problems.involvementReason = t("people.preAdmission.involvement.reasonRequired");
    }
    if (Object.keys(problems).length > 0) {
      form.setResult(fieldErrors(problems));
      return;
    }
    form.run(
      () =>
        saveAssessmentSources(personId, version, {
          informationSources: chosen,
          involved: answer === "yes",
          reason: why,
        }),
      () => inline.hide(),
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {inline.open ? (
        <form
          method="post"
          className="flex flex-col gap-4 border-s-4 border-border ps-4"
          onSubmit={submit}
          noValidate
        >
          <fieldset
            className="m-0 flex flex-col gap-2 border-0 p-0"
            aria-describedby={
              errorFor(form.result, "informationSources")
                ? `${ids.informationSources}-error`
                : undefined
            }
          >
            <legend className="font-semibold">{t("people.preAdmission.sources.legend")}</legend>
            {errorFor(form.result, "informationSources") ? (
              <p id={`${ids.informationSources}-error`} className="hb-field__error m-0">
                {errorFor(form.result, "informationSources")}
              </p>
            ) : null}
            {INFORMATION_SOURCES.map((source, index) => (
              <Checkbox
                key={source}
                {...(index === 0 ? { id: ids.informationSources } : {})}
                name="informationSources"
                value={source}
                defaultChecked={sources.includes(source)}
                label={t("people.preAdmission.source", { source })}
              />
            ))}
          </fieldset>
          <RadioGroup<"yes" | "no">
            id={ids.involved}
            name="involved"
            legend={t("people.preAdmission.involvement.legend")}
            layout="inline"
            value={answer}
            onValueChange={setAnswer}
            error={errorFor(form.result, "involved")}
            options={[
              { value: "yes", label: t("people.preAdmission.involvement.yes") },
              { value: "no", label: t("people.preAdmission.involvement.no") },
            ]}
          />
          {answer === "no" ? (
            <TextArea
              id={ids.involvementReason}
              name="involvementReason"
              label={t("people.preAdmission.involvement.reason")}
              defaultValue={reason ?? ""}
              rows={3}
              required
              maxLength={1000}
              formatCount={(remaining) => characterCount(remaining)}
              error={errorFor(form.result, "involvementReason")}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={form.pending}>
              {form.pending ? t("common.saving") : t("people.preAdmission.sources.save")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                form.setResult(null);
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
            icon={<PencilLine size={16} strokeWidth={1.5} />}
            onClick={() => {
              form.setResult(null);
              inline.show();
              requestAnimationFrame(() => document.getElementById(ids.informationSources)?.focus());
            }}
          >
            {t("people.preAdmission.sources.edit")}
          </Button>
        </div>
      )}
      <FormFeedback
        result={form.result}
        success={t("people.preAdmission.sources.saved")}
        fieldIds={ids}
      />
    </div>
  );
}
