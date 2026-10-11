"use client";

import * as RadioGroup from "@radix-ui/react-radio-group";
import { type ReactNode, useId } from "react";
import { cx } from "../../lib/cx";

export interface SegmentedControlOption<Value extends string> {
  value: Value;
  label: string;
  /** A decorative Lucide icon shown before the label. */
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<Value extends string> {
  /** Names the group, for example "Row density". */
  label: string;
  /** Hide the label visually; it is still announced. */
  hideLabel?: boolean;
  options: readonly SegmentedControlOption<Value>[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
  /** Form field name, when used inside a form. */
  name?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A row of mutually exclusive options with radio-group semantics. Tab moves into the group, arrow
 * keys move between options and select them, as with native radio buttons.
 */
export function SegmentedControl<Value extends string>({
  label,
  hideLabel = false,
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  disabled,
  className,
}: SegmentedControlProps<Value>) {
  const labelId = useId();
  return (
    <div className={cx("hb-segmented", className)}>
      <span id={labelId} className={hideLabel ? "hb-visually-hidden" : "hb-segmented__label"}>
        {label}
      </span>
      <RadioGroup.Root
        aria-labelledby={labelId}
        className="hb-segmented__track"
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => onValueChange?.(next as Value)}
        name={name}
        disabled={disabled}
        loop
      >
        {options.map((option) => (
          <RadioGroup.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="hb-segmented__item"
          >
            {option.icon != null ? (
              <span className="hb-segmented__icon" aria-hidden="true">
                {option.icon}
              </span>
            ) : null}
            <span>{option.label}</span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </div>
  );
}
