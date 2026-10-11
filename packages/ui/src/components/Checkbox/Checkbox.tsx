import { type InputHTMLAttributes, type Ref, useId } from "react";
import { cx } from "../../lib/cx";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> {
  /** What ticking the box means, as a statement: "Skin checked". */
  label: string;
  hint?: string;
  error?: string;
  ref?: Ref<HTMLInputElement>;
}

/**
 * A native checkbox with its label beside it. The box and the label are one label element, at
 * least 44 px tall and as wide as the row, so a tap anywhere on the row ticks it. A ticked box
 * shows a tick, never colour alone; a box with an error keeps its focus ring.
 */
export function Checkbox({ label, hint, error, id, className, ref, ...rest }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("hb-check", error && "hb-check--invalid", className)}>
      <label htmlFor={inputId} className="hb-check__target">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className="hb-check__input"
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
        <span className="hb-check__label">{label}</span>
      </label>
      {hint ? (
        <p id={hintId} className="hb-field__hint hb-check__detail">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="hb-field__error hb-check__detail">
          {error}
        </p>
      ) : null}
    </div>
  );
}
