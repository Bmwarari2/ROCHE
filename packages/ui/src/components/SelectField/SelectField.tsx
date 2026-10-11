import { type Ref, type SelectHTMLAttributes, useId } from "react";
import { cx } from "../../lib/cx";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptionGroup {
  label: string;
  options: readonly SelectOption[];
}

export interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  /** Visible label. Always shown. */
  label: string;
  hint?: string;
  /** Say what to do, never blame: "Choose a meal". */
  error?: string;
  options?: readonly SelectOption[];
  /** Options in labelled groups (`optgroup`), shown after `options`. */
  groups?: readonly SelectOptionGroup[];
  /**
   * A first, empty choice such as "Choose a body area". With `required`, the form cannot be sent
   * until a real choice is made.
   */
  emptyOption?: string;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * A labelled native select, 44 px tall with 12 px corners, with optional hint and error. Native,
 * so phones show their own picker and screen readers announce it as a list box.
 */
export function SelectField({
  label,
  hint,
  error,
  options = [],
  groups = [],
  emptyOption,
  id,
  className,
  ref,
  ...rest
}: SelectFieldProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("hb-field", error && "hb-field--invalid", className)}>
      <label htmlFor={selectId} className="hb-field__label">
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
      <select
        ref={ref}
        id={selectId}
        className="hb-field__input hb-field__select"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        {...rest}
      >
        {emptyOption != null ? <option value="">{emptyOption}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
