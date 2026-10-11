"use client";

import { DateTimeInput, type DateTimePart, dateTimePartsAt, RadioGroup } from "@harbour/ui";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { dateTimeLabels, type FieldPart } from "@/lib/uk-time";

type Mode = "now" | "earlier";

/**
 * When an entry happened (hazards HZ-009 and HZ-017). It says "Now" until someone changes it, and
 * "now" is the moment the form is sent, so a form left open never records the time the page was
 * drawn. "Earlier" opens the date and time boxes (UK time, 24-hour), filled with the time it was
 * chosen; a late entry is flagged by the API. In the hour the clocks go back, the boxes ask which
 * of the two times was meant.
 */
export function WhenField({
  name = "occurredAt",
  legend = t("care.entry.when"),
  id,
  error,
  errorParts,
}: {
  readonly name?: string;
  readonly legend?: string;
  /** The id an error summary links to: the first choice, or the day box once it is shown. */
  readonly id?: string;
  readonly error?: string;
  readonly errorParts?: readonly FieldPart[];
}) {
  const [mode, setMode] = useState<Mode>("now");
  const [start, setStart] = useState<Record<DateTimePart, string> | null>(null);
  const onTime = errorParts?.some((part) => part !== "mode") ?? false;
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup<Mode>
        legend={legend}
        hint={t("care.entry.whenHint")}
        name={`${name}-mode`}
        layout="inline"
        value={mode}
        onValueChange={(next) => {
          if (next === "earlier" && start === null) setStart(dateTimePartsAt(Date.now()));
          setMode(next);
        }}
        {...(mode === "now" && id ? { id } : {})}
        {...(error && !(mode === "earlier" && onTime) ? { error } : {})}
        options={[
          { value: "now", label: t("care.when.now"), description: t("care.when.nowHint") },
          {
            value: "earlier",
            label: t("care.when.earlier"),
            description: t("care.when.earlierHint"),
          },
        ]}
      />
      {mode === "earlier" ? (
        <DateTimeInput
          legend={t("care.when.enter")}
          hint={t("care.when.hint")}
          name={name}
          defaultValue={start}
          labels={dateTimeLabels(t)}
          {...(id ? { id } : {})}
          {...(error && onTime
            ? {
                error,
                errorParts: errorParts?.filter(
                  (part): part is DateTimePart | "fold" => part !== "mode",
                ),
              }
            : {})}
        />
      ) : null}
    </div>
  );
}
