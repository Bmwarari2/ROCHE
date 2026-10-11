import { type ReactNode, useId } from "react";
import { cx } from "../../lib/cx";
import { type DatePart, datePartName, datePartsOf, type TimePart } from "../../lib/zoned-time";

export interface DatePartLabels {
  day: string;
  month: string;
  year: string;
}

export const defaultDatePartLabels: DatePartLabels = { day: "Day", month: "Month", year: "Year" };

export interface DateInputProps {
  /** The question, as the fieldset's legend: "Date of the assessment". */
  legend: string;
  hideLegend?: boolean;
  /** For example "For example, 27 3 2026". */
  hint?: string;
  /** Say what to do, never blame: "The date must include a month". */
  error?: string;
  /** The boxes the error is about; all three when not given. */
  errorParts?: readonly DatePart[];
  /** Form field name; each box is named `${name}-day`, `${name}-month` and `${name}-year`. */
  name: string;
  /** The day box's id, so an error summary can link to the question. */
  id?: string;
  /** "yyyy-mm-dd", or empty. */
  defaultValue?: string | null;
  labels?: DatePartLabels;
  className?: string;
}

const PARTS: readonly { readonly part: DatePart; readonly size: "2" | "4" }[] = [
  { part: "day", size: "2" },
  { part: "month", size: "2" },
  { part: "year", size: "4" },
];

export interface DatePartBoxProps {
  readonly name: string;
  readonly part: DatePart | TimePart;
  readonly label: string;
  readonly id: string;
  readonly size: "2" | "4";
  readonly invalid: boolean;
  readonly errorId: string | undefined;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
}

/** One labelled box of a date or time: numbers only, sized for 2 or 4 digits. */
export function DatePartBox({
  name,
  part,
  label,
  id,
  size,
  invalid,
  errorId,
  value,
  defaultValue,
  onValueChange,
}: DatePartBoxProps): ReactNode {
  return (
    <div className={cx("hb-date__item", `hb-date__item--${part}`)}>
      <label htmlFor={id} className="hb-date__label">
        {label}
      </label>
      <input
        id={id}
        name={datePartName(name, part)}
        className={cx("hb-field__input", "hb-date__input", `hb-date__input--${size}`)}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={Number(size)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        {...(value !== undefined
          ? { value, onChange: (event) => onValueChange?.(event.currentTarget.value) }
          : { defaultValue })}
      />
    </div>
  );
}

/**
 * A date as day, month and year in three boxes (the GOV.UK date input pattern), so it reads
 * dd/mm/yyyy whatever the browser's language: a native date picker shows the date in the
 * device's own format, which on a US device is month first. The boxes take numbers only; an error
 * marks only the boxes it is about.
 */
export function DateInput({
  legend,
  hideLegend = false,
  hint,
  error,
  errorParts,
  name,
  id,
  defaultValue,
  labels = defaultDatePartLabels,
  className,
}: DateInputProps) {
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const hintId = hint ? `${baseId}-hint` : undefined;
  const errorId = error ? `${baseId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const defaults = datePartsOf(defaultValue);
  const invalid = (part: DatePart) =>
    Boolean(error) && (errorParts === undefined || errorParts.includes(part));
  return (
    <fieldset
      className={cx("hb-date", error && "hb-date--invalid", className)}
      aria-describedby={describedBy}
    >
      <legend className={hideLegend ? "hb-visually-hidden" : "hb-date__legend"}>{legend}</legend>
      {hint ? (
        <p id={hintId} className="hb-field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="hb-field__error">
          {error}
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
            defaultValue={defaults[part]}
          />
        ))}
      </div>
    </fieldset>
  );
}
