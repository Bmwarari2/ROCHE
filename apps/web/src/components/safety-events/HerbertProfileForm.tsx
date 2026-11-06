"use client";

import type { HerbertProfileView } from "@harbour/contracts";
import { Button, Checkbox, DateInput, TextArea } from "@harbour/ui";
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
  const ids = useFieldIds([...HERBERT_TEXT_FIELDS, "reviewedOn", "prefillChecked"]);
  const suggestion = (field: HerbertTextField): string | null =>
    profile ? null : ((prefill[field] as string | null | undefined) ?? null);
  // A first profile with any prefilled part needs each part confirmed before it is saved (HZ-127).
  const prefilled = HERBERT_TEXT_FIELDS.some((field) => Boolean(suggestion(field)));
  const { submit, result, pending } = useSubmit(
    (form) => readHerbertProfile(form, t, { version: profile?.version ?? 0, today, prefilled }),
    (body) => saveHerbertProfile(personId, body),
  );
  return (
    <form method="post" className="flex flex-col gap-5" onSubmit={submit} noValidate>
      {profile?.photoDocumentId ? (
        <input type="hidden" name="photoDocumentId" value={profile.photoDocumentId} />
      ) : null}
      {HERBERT_TEXT_FIELDS.map((field) => {
        const required = HERBERT_REQUIRED.includes(field);
        const suggested = suggestion(field);
        const sources = prefillSources(suggested);
        const filledIn = Boolean(suggested) && !required;
        const value = profile
          ? ((profile[field] as string | null) ?? "")
          : filledIn
            ? suggested
            : "";
        // Where a prefilled part came from (and, for a field never prefilled, the suggestion
        // itself) is in the field's hint, so screen readers hear it with the field.
        const source = suggested
          ? t(filledIn ? "herbert.prefill.filled" : "herbert.prefill.suggested", {
              sources:
                sources.map((s) => t("herbert.prefill.source", { source: s })).join(", ") ||
                t("herbert.prefill.source", { source: "record" }),
            })
          : null;
        const hint = [
          t("herbert.hint", { field }),
          source,
          required && suggested ? t("herbert.prefill.suggestion", { text: suggested }) : null,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={field} className="flex flex-col gap-2" data-herbert-field={field}>
            <TextArea
              id={ids[field]}
              name={field}
              label={t("herbert.field", { field })}
              hint={hint}
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
      {prefilled ? (
        <Checkbox
          id={ids.prefillChecked}
          name="prefillChecked"
          value="yes"
          label={t("herbert.form.prefillCheck")}
          hint={t("herbert.form.prefillCheckHint")}
          error={errorFor(result, "prefillChecked")}
        />
      ) : null}
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
