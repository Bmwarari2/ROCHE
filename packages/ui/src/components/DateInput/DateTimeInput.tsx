"use client";

import { useId, useState } from "react";
import { cx } from "../../lib/cx";
import {
  checkWallClockParts,
  type DateTimePart,
  datePartName,
  type Fold,
  type WallClock,
} from "../../lib/zoned-time";
import { RadioGroup } from "../RadioGroup/RadioGroup";
import { DatePartBox, type DatePartLabels, defaultDatePartLabels } from "./DateInput";

export interface DateTimeLabels extends DatePartLabels {
  hour: string;
  minute: string;
  /** The question when the clocks went back over the time entered. */
  foldLegend: (args: { time: string; date: string }) => string;
  /** One of the two times: "01:30 BST, before the clocks went back". */
  foldOption: (args: { time: string; zone: string; which: Fold }) => string;
}

/**
 * The zones of the two times a wall-clock time stands for, when it happened twice and the app
 * needs to ask which one was meant, for example `{ first: "BST", second: "GMT" }`.
 */
export interface RepeatedTime {
  readonly first: string;
  readonly second: string;
}

export const defaultDateTimeLabels: DateTimeLabels = {
  ...defaultDatePartLabels,
  hour: "Hour",
  minute: "Minute",
  foldLegend: ({ time, date }) =>
    `The clocks went back on ${date}, so ${time} happened twice. Which ${time} was it?`,
  foldOption: ({ time, zone, which }) =>
    `${time} ${zone}, ${which === "first" ? "before" : "after"} the clocks went back`,
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
  /**
   * Whether the time typed happened twice (the clocks went back) and the person must choose which,
   * by the app's own rule; null when it did not. Without it the question is never asked.
   */
  repeated?: (wall: WallClock) => RepeatedTime | null;
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

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * A date and a 24-hour time in five boxes, so it reads dd/mm/yyyy and 24-hour on any device, in
 * any browser language. When the app's `repeated` rule says the time typed happened twice (the
 * clocks went back), a required question asks which one; it appears only then, with nothing
 * chosen. The app refuses a time that never happened (the clocks went forward) when the form is
 * sent, with words that say so.
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
  repeated: repeatedRule,
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

  const read = checkWallClockParts(values);
  const wall = read.ok ? read.wall : null;
  const repeated = wall && repeatedRule ? repeatedRule(wall) : null;
  const time = wall ? `${pad(wall.hour)}:${pad(wall.minute)}` : "";
  const date = wall ? `${pad(wall.day)}/${pad(wall.month)}/${wall.year}` : "";

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
              zone: which === "first" ? repeated.first : repeated.second,
              which,
            }),
          }))}
        />
      ) : null}
    </div>
  );
}
