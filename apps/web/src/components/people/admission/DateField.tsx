"use client";

import { DateInput } from "@harbour/ui";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor } from "@/lib/outcome";
import { dateBoxesOf } from "@/lib/uk-time";

/**
 * A date (dd/mm/yyyy in three labelled boxes) with the form's error at it and the boxes the error
 * is about. Used for every calendar date on the admission and property forms.
 */
export function DateField({
  id,
  name,
  legend,
  hint = t("care.date.hint"),
  result,
  defaultValue,
}: {
  readonly id: string;
  readonly name: string;
  readonly legend: string;
  readonly hint?: string;
  readonly result: ActionResult<unknown> | null;
  readonly defaultValue?: string | null;
}) {
  return (
    <DateInput
      id={id}
      name={name}
      legend={legend}
      hint={hint}
      defaultValue={defaultValue ?? null}
      error={errorFor(result, name)}
      errorParts={dateBoxesOf(partsFor(result, name))}
      labels={{ day: t("care.date.day"), month: t("care.date.month"), year: t("care.date.year") }}
    />
  );
}
