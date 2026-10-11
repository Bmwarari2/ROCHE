"use client";

import { type ReactNode, useId } from "react";
import { cx } from "../../lib/cx";

export interface RadioOption<Value extends string> {
  value: Value;
  label: string;
  /** A second line under the label, for example the published wording of a scale point. */
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<Value extends string> {
  /** The question, shown as the fieldset's legend: "Which side of the person's body?" */
  legend: string;
  /** Hide the legend visually; it is still announced. */
  hideLegend?: boolean;
  hint?: string;
  /** Say what to do, never blame: "Choose the side in words". */
  error?: string;
  /** Form field name; one name per group. */
  name: string;
  /**
   * The id of the first choice's radio, so an error summary can link to the question and move
   * focus to it.
   */
  id?: string;
  options: readonly RadioOption<Value>[];
  /** Controlled value; null for nothing chosen yet. */
  value?: Value | null;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
  /** "stack" lists options one per row; "inline" wraps them in a row; "grid" fills two columns. */
  layout?: "stack" | "inline" | "grid";
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A question with one answer from a few choices, as native radio buttons in a fieldset. Each
 * choice is a card at least 44 px tall whose whole area selects it; arrow keys move between
 * choices as the browser provides. The chosen card shows a filled dot, a thicker border and bold
 * text, never colour alone. With an error, the fieldset is described by it and every radio is
 * marked invalid, so the error is announced whichever choice has focus.
 */
export function RadioGroup<Value extends string>({
  legend,
  hideLegend = false,
  hint,
  error,
  name,
  id: firstId,
  options,
  value,
  defaultValue,
  onValueChange,
  layout = "stack",
  required,
  disabled,
  className,
}: RadioGroupProps<Value>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const controlled = value !== undefined;
  return (
    <fieldset
      className={cx("hb-choice", error && "hb-choice--invalid", className)}
      aria-describedby={describedBy}
      disabled={disabled}
    >
      <legend className={hideLegend ? "hb-visually-hidden" : "hb-choice__legend"}>{legend}</legend>
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
      <div className={cx("hb-choice__options", `hb-choice__options--${layout}`)}>
        {options.map((option, index) => {
          // The card is one click target; the label names the radio and the description
          // describes it, so a screen reader reads "Left, radio button, The person's own left".
          const labelId = `${id}-${index}-label`;
          const descriptionId = option.description != null ? `${id}-${index}-description` : null;
          return (
            <label
              key={option.value}
              className={cx("hb-choice__option", option.disabled && "hb-choice__option--disabled")}
            >
              <input
                type="radio"
                className="hb-choice__input"
                name={name}
                value={option.value}
                id={index === 0 ? firstId : undefined}
                aria-labelledby={labelId}
                aria-describedby={descriptionId ?? undefined}
                aria-invalid={error ? true : undefined}
                disabled={option.disabled}
                required={required}
                {...(controlled
                  ? { checked: value === option.value }
                  : { defaultChecked: defaultValue === option.value })}
                onChange={(event) => {
                  if (event.currentTarget.checked) onValueChange?.(option.value);
                }}
              />
              <span className="hb-choice__text">
                <span id={labelId} className="hb-choice__label">
                  {option.label}
                </span>
                {descriptionId ? (
                  <span id={descriptionId} className="hb-choice__description">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
