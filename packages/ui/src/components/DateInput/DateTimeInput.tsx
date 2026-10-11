"use client";

import { useId, useState } from "react";
import { cx } from "../../lib/cx";
import {
  type DateTimePart,
  datePartName,
  type Fold,
  resolveWallClock,
  UK_TIME_ZONE,
} from "../../lib/zoned-time";
import { RadioGroup } from "../RadioGroup/RadioGroup";
import { DatePartBox, type DatePartLabels, defaultDatePartLabels } from "./DateInput";

export interface DateTimeLabels extends DatePartLabels {
  hour: string;
  minute: string;
  /** The question when the clocks went back over the time entered. */
  foldLegend: (args: { time: string; date: string }) => string;
  /** One of the two times: "01:30 BST (the first time)". */
  foldOption: (args: { time: string; zone: string; which: Fold }) => string;
}

export const defaultDateTimeLabels: DateTimeLabels = {
  ...defaultDatePartLabels,
  hour: "Hour",
  minute: "Minute",
  foldLegend: ({ time, date }) =>
    `The clocks went back on ${date}, so ${time} happened twice. Which ${time} was it?`,
  foldOption: ({ time, zone, which }) =>
    `${time} ${zone} (${which === "first" ? "the first time" : "the second time"})`,
};

export interface DateTimeInputProps {
  /** The question, as the fieldset's legend: "When did it happen?" */
  legend: string;
  hideLegend?: boolean;
  /** For example "Use the 24-hour clock: 14 30 for half past two in the afternoon." */
  hint?: string;
  /** Say what to do, never blame. */
  error?: string;
  /**
   * The boxes the error is about; all five when not given. ["fold"] puts the error on the
   * question that asks which of a repeated time was meant.
   */
  errorParts?: readonly (DateTimePart | "fold")[];
  /** Form field name; boxes are `${name}-day` to `${name}-minute`, the choice `${name}-fold`. */
  name: string;
  /** The day box's id, so an error summary can link to the question. */
  id?: string;
  defaultValue?: Readonly<Partial<Record<DateTimePart, string>>> | null;
  /** The zone the wall clock is in. */
  timeZone?: string;
  labels?: DateTimeLabels;
  className?: string;
}

const PARTS: readonly { readonly part: DateTimePart; readonly size: "2" | "4" }[] = [
  { part: "day", size: "2" },
  { part: "month", size: "2" },
  { part: "year", size: "4" },
  { part: "hour", size: "2" },
  { part: "minute", size: "2" },
];

const EMPTY: Record<DateTimePart, string> = { day: "", month: "", year: "", hour: "", minute: "" };

/** Digits that make a whole number in range, or null. */
function whole(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > 4) return null;
  for (const char of trimmed) {
    if (char < "0" || char > "9") return null;
  }
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * A date and a 24-hour time in five boxes, read in a named time zone (UK time by default), so it
 * reads the same on any device. When the clocks went back over the time entered, the hour
 * happened twice, and a required question asks which one (the first, in summer time, or the
 * second); it appears only then. A time in the hour the clocks went forward never happened, and
 * the form refuses it with words that say so.
 */
export function DateTimeInput({
  legend,
  hideLegend = false,
  hint,
  error,
  errorParts,
  name,
  id,
  defaultValue,
  timeZone = UK_TIME_ZONE,
  labels = defaultDateTimeLabels,
  className,
}: DateTimeInputProps) {
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const [values, setValues] = useState<Record<DateTimePart, string>>({
    ...EMPTY,
    ...defaultValue,
  });
  const [fold, setFold] = useState<Fold | null>(null);
  const hintId = hint ? `${baseId}-hint` : undefined;
  const foldOnly = errorParts?.length === 1 && errorParts[0] === "fold";
  const fieldError = foldOnly ? undefined : error;
  const errorId = fieldError ? `${baseId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const invalid = (part: DateTimePart) =>
    Boolean(fieldError) && (errorParts === undefined || errorParts.includes(part));

  const year = whole(values.year, 1900, 9999);
  const month = whole(values.month, 1, 12);
  const day = whole(values.day, 1, 31);
  const hour = whole(values.hour, 0, 23);
  const minute = whole(values.minute, 0, 59);
  const resolution =
    year !== null && month !== null && day !== null && hour !== null && minute !== null
      ? resolveWallClock({ year, month, day, hour, minute }, timeZone)
      : null;
  const repeated = resolution?.kind === "repeated" ? resolution : null;
  const time = hour !== null && minute !== null ? `${pad(hour)}:${pad(minute)}` : "";
  const date =
    day !== null && month !== null && year !== null ? `${pad(day)}/${pad(month)}/${year}` : "";

  return (
    <div className={cx("hb-datetime", className)}>
      <fieldset
        className={cx("hb-date", fieldError && "hb-date--invalid")}
        aria-describedby={describedBy}
      >
        <legend className={hideLegend ? "hb-visually-hidden" : "hb-date__legend"}>{legend}</legend>
        {hint ? (
          <p id={hintId} className="hb-field__hint">
            {hint}
          </p>
        ) : null}
        {fieldError ? (
          <p id={errorId} className="hb-field__error">
            {fieldError}
          </p>
        ) : null}
        <div className="hb-date__row">
          {PARTS.map(({ part, size }) => (
            <DatePartBox
              key={part}
              name={name}
              part={part}
              label={labels[part]}
              id={part === "day" ? baseId : `${baseId}-${part}`}
              size={size}
              invalid={invalid(part)}
              errorId={errorId}
              value={values[part]}
              onValueChange={(value) => setValues((current) => ({ ...current, [part]: value }))}
            />
          ))}
        </div>
      </fieldset>
      {repeated ? (
        <RadioGroup<Fold>
          id={`${baseId}-fold`}
          legend={labels.foldLegend({ time, date })}
          name={datePartName(name, "fold")}
          required
          value={fold}
          onValueChange={setFold}
          {...(foldOnly && error ? { error } : {})}
          options={(["first", "second"] as const).map((which) => ({
            value: which,
            label: labels.foldOption({
              time,
              zone: (which === "first" ? repeated.first : repeated.second).zoneName,
              which,
            }),
          }))}
        />
      ) : null}
    </div>
  );
}
