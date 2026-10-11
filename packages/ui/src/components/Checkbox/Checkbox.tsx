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
 * A native checkbox with its label beside it. The label and the box together give a target at
 * least 44 px tall; a ticked box shows a tick, never colour alone.
 */
export function Checkbox({ label, hint, error, id, className, ref, ...rest }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("hb-check", error && "hb-check--invalid", className)}>
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className="hb-check__input"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      <div className="hb-check__text">
        <label htmlFor={inputId} className="hb-check__label">
          {label}
        </label>
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
      </div>
    </div>
  );
}
