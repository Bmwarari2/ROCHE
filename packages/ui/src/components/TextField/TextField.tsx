import { type InputHTMLAttributes, type Ref, useId } from "react";
import { cx } from "../../lib/cx";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "children"> {
  /** Visible label. Always shown: placeholders are not labels. */
  label: string;
  /** Help shown under the label, for example "For example, 01/02/1940". */
  hint?: string;
  /** Error message. Say what to do, never blame: "Enter a date of birth". */
  error?: string;
  ref?: Ref<HTMLInputElement>;
}

/** A labelled text input with optional hint and error, 44 px tall with 12 px corners. */
export function TextField({ label, hint, error, id, className, ref, ...rest }: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("hb-field", error && "hb-field--invalid", className)}>
      <label htmlFor={inputId} className="hb-field__label">
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
      <input
        ref={ref}
        id={inputId}
        className="hb-field__input"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
    </div>
  );
}
