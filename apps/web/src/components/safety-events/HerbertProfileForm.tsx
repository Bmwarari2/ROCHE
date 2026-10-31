"use client";

import type { HerbertProfileView } from "@harbour/contracts";
import { Button, DateInput, TextArea } from "@harbour/ui";
import { Save } from "lucide-react";
import { saveHerbertProfile } from "@/app/actions/missing";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import {
  HERBERT_REQUIRED,
  HERBERT_TEXT_FIELDS,
  type HerbertTextField,
  herbertMax,
  prefillSources,
  readHerbertProfile,
} from "@/lib/missing";
import { errorFor, partsFor } from "@/lib/outcome";
import { dateBoxesOf, dateTimeLabels } from "@/lib/uk-time";
import { useSubmit } from "./use-submit";

type Prefill = HerbertProfileView["prefill"];
type Saved = NonNullable<HerbertProfileView["profile"]>;

/**
 * The Herbert Protocol profile (SAFE-015): what the police need to find the person. A new profile
 * starts from what the record already holds, every prefilled part marked with where it came from
 * and to be checked with the person and their family before saving; it is never saved as it is.
 * What the person looks like and where they may go are written by someone, never prefilled into
 * the field: any suggestion from the record is shown beside it.
 */
export function HerbertProfileForm({
  personId,
  profile,
  prefill,
  today,
}: {
  readonly personId: string;
  readonly profile: Saved | null;
  readonly prefill: Prefill;
  readonly today: string;
}) {
  const ids = useFieldIds([...HERBERT_TEXT_FIELDS, "reviewedOn"]);
  const { submit, result, pending } = useSubmit(
    (form) => readHerbertProfile(form, t, { version: profile?.version ?? 0, today }),
    (body) => saveHerbertProfile(personId, body),
  );
  const suggestion = (field: HerbertTextField): string | null =>
    profile ? null : ((prefill[field] as string | null | undefined) ?? null);
  return (
    <form method="post" className="flex flex-col gap-5" onSubmit={submit} noValidate>
      {profile?.photoDocumentId ? (
        <input type="hidden" name="photoDocumentId" value={profile.photoDocumentId} />
      ) : null}
      {HERBERT_TEXT_FIELDS.map((field) => {
        const required = HERBERT_REQUIRED.includes(field);
        const suggested = suggestion(field);
        const sources = prefillSources(suggested);
        const prefilled = Boolean(suggested) && !required;
        const value = profile
          ? ((profile[field] as string | null) ?? "")
          : prefilled
            ? suggested
            : "";
        return (
          <div key={field} className="flex flex-col gap-2" data-herbert-field={field}>
            {suggested ? (
              <div className="flex flex-col gap-1 rounded-input border-s-4 border-accent bg-bg-secondary p-3">
                <p className="m-0 text-body-dense font-semibold">
                  {t(prefilled ? "herbert.prefill.filled" : "herbert.prefill.suggested", {
                    sources:
                      sources.map((s) => t("herbert.prefill.source", { source: s })).join(", ") ||
                      t("herbert.prefill.source", { source: "record" }),
                  })}
                </p>
                {required ? <p className="m-0 whitespace-pre-wrap">{suggested}</p> : null}
              </div>
            ) : null}
            <TextArea
              id={ids[field]}
              name={field}
              label={t("herbert.field", { field })}
              hint={t("herbert.hint", { field })}
              rows={field === "phoneOrTracker" || field === "reviewedWith" ? 2 : 4}
              maxLength={herbertMax(field)}
              defaultValue={value ?? ""}
              required={required}
              formatCount={(remaining) => characterCount(remaining)}
              error={errorFor(result, field)}
            />
          </div>
        );
      })}
      <DateInput
        id={ids.reviewedOn}
        name="reviewedOn"
        legend={t("herbert.form.reviewedOn")}
        hint={t("herbert.form.reviewedHint")}
        labels={dateTimeLabels(t)}
        error={errorFor(result, "reviewedOn")}
        errorParts={dateBoxesOf(partsFor(result, "reviewedOn"))}
      />
      <div>
        <Button
          type="submit"
          icon={<Save size={18} strokeWidth={1.5} aria-hidden="true" />}
          disabled={pending}
        >
          {pending ? t("common.saving") : t("herbert.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("herbert.form.done")} fieldIds={ids} />
    </form>
  );
}
