"use client";

import {
  type ChangeEvent,
  type Ref,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useState,
} from "react";
import { cx } from "../../lib/cx";
import { VisuallyHidden } from "../../lib/VisuallyHidden";

/** How long typing must pause before a screen reader hears the new count, in milliseconds. */
export const CHARACTER_COUNT_ANNOUNCE_DELAY = 1000;

/** The English count message: "You have 12 characters remaining" or "You have 3 characters too many". */
export function defaultCharacterCount(remaining: number): string {
  const count = Math.abs(remaining);
  const characters = `${count.toLocaleString("en-GB")} ${count === 1 ? "character" : "characters"}`;
  return remaining >= 0 ? `You have ${characters} remaining` : `You have ${characters} too many`;
}

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "children" | "maxLength"> {
  /** Visible label. Always shown: placeholders are not labels. */
  label: string;
  /** Help shown under the label, for example "At least 20 characters". */
  hint?: string;
  /** Error message. Say what to do, never blame: "Explain why you need this record". */
  error?: string;
  /**
   * Shows a character count against this maximum under the field. The browser does not cut the
   * text off (pasted text would be lost without warning); the count says how many characters are
   * too many, and the form checks the limit when it is sent.
   */
  maxLength?: number;
  /**
   * Words for the count, given the characters remaining (negative when over the limit) and the
   * maximum. Apps pass a translated message; the default is English.
   */
  formatCount?: (remaining: number, maxLength: number) => string;
  ref?: Ref<HTMLTextAreaElement>;
}

/**
 * A labelled multi-line text field with optional hint, error and character count, styled like
 * `TextField`. The hint, error and count describe the field (`aria-describedby`), and a polite live
 * region reads the count once typing pauses, so screen reader users are not interrupted on every
 * key.
 */
export function TextArea({
  label,
  hint,
  error,
  maxLength,
  formatCount = defaultCharacterCount,
  id,
  className,
  rows = 5,
  value,
  defaultValue,
  onChange,
  ref,
  ...rest
}: TextAreaProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const hasCount = maxLength !== undefined;
  const countId = hasCount ? `${fieldId}-count` : undefined;
  const describedBy = [hintId, errorId, countId].filter(Boolean).join(" ") || undefined;

  const [uncontrolledLength, setUncontrolledLength] = useState(
    () => String(defaultValue ?? "").length,
  );
  const length = value === undefined ? uncontrolledLength : String(value).length;
  const remaining = hasCount ? maxLength - length : 0;
  const over = hasCount && remaining < 0;
  const countText = hasCount ? formatCount(remaining, maxLength) : "";

  // The live region lags behind the visible count so it speaks once typing pauses.
  const [announced, setAnnounced] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!hasCount || !touched) return;
    const timer = setTimeout(() => setAnnounced(countText), CHARACTER_COUNT_ANNOUNCE_DELAY);
    return () => clearTimeout(timer);
  }, [countText, hasCount, touched]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (value === undefined) setUncontrolledLength(event.currentTarget.value.length);
    setTouched(true);
    onChange?.(event);
  };

  return (
    <div className={cx("hb-field", error && "hb-field--invalid", className)}>
      <label htmlFor={fieldId} className="hb-field__label">
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
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        className="hb-field__input hb-field__input--multiline"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
        {...rest}
      />
      {hasCount ? (
        <>
          {/* Read as part of the field's description; the live region below announces changes. */}
          <p
            id={countId}
            className={cx("hb-field__count", over && "hb-field__count--over")}
            aria-hidden="true"
            data-over={over ? "true" : undefined}
          >
            {countText}
          </p>
          <VisuallyHidden aria-live="polite">{announced}</VisuallyHidden>
        </>
      ) : null}
    </div>
  );
}
