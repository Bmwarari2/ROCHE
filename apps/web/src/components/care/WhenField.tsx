"use client";

import { DateTimeInput, type DateTimePart, dateTimePartsAt, RadioGroup } from "@harbour/ui";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { boxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";

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
  explicit,
}: {
  readonly name?: string;
  readonly legend?: string;
  /** The id an error summary links to: the first choice, or the day box once it is shown. */
  readonly id?: string;
  readonly error?: string;
  /** The boxes the error is about; all of them when not given. */
  readonly errorParts?: readonly string[];
  /**
   * Nothing chosen until the person chooses, with these words for the two choices (an incident,
   * whose clocks start at this time: HZ-090). "Now" is then taken by the server, not the browser.
   */
  readonly explicit?: {
    readonly hint: string;
    readonly now: { readonly label: string; readonly description: string };
    readonly earlier: { readonly label: string; readonly description: string };
  };
}) {
  const [mode, setMode] = useState<Mode | null>(explicit ? null : "now");
  const [start, setStart] = useState<Record<DateTimePart, string> | null>(null);
  const boxes = boxesOf(errorParts);
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup<Mode>
        legend={legend}
        hint={explicit?.hint ?? t("care.entry.whenHint")}
        name={`${name}-mode`}
        layout="inline"
        value={mode}
        onValueChange={(next) => {
          if (next === "earlier" && start === null) setStart(dateTimePartsAt(Date.now()));
          setMode(next);
        }}
        {...(mode !== "earlier" && id ? { id } : {})}
        {...(mode !== "earlier" && error ? { error } : {})}
        {...(explicit ? { required: true } : {})}
        options={[
          {
            value: "now",
            label: explicit?.now.label ?? t("care.when.now"),
            description: explicit?.now.description ?? t("care.when.nowHint"),
          },
          {
            value: "earlier",
            label: explicit?.earlier.label ?? t("care.when.earlier"),
            description: explicit?.earlier.description ?? t("care.when.earlierHint"),
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
          repeated={ukRepeatedTime}
          {...(id ? { id } : {})}
          {...(error ? { error, ...(boxes ? { errorParts: boxes } : {}) } : {})}
        />
      ) : null}
    </div>
  );
}
