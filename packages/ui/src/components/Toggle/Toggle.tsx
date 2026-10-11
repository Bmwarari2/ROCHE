"use client";

import * as Switch from "@radix-ui/react-switch";
import { useId } from "react";
import { cx } from "../../lib/cx";

export interface ToggleProps {
  /** Visible label. Say what is on, for example "Email me when a note is corrected". */
  label: string;
  /** Extra help shown under the label. */
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Form field name, when used inside a form. */
  name?: string;
  value?: string;
  id?: string;
  className?: string;
}

/** An on and off switch with a visible label. Space or Enter toggles it. */
export function Toggle({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  name,
  value,
  id,
  className,
}: ToggleProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const descriptionId = description ? `${switchId}-description` : undefined;
  return (
    <div className={cx("hb-toggle", disabled && "hb-toggle--disabled", className)}>
      <div className="hb-toggle__text">
        <label htmlFor={switchId} className="hb-toggle__label">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="hb-toggle__description">
            {description}
          </p>
        ) : null}
      </div>
      <Switch.Root
        id={switchId}
        className="hb-toggle__switch"
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        name={name}
        value={value}
        aria-describedby={descriptionId}
      >
        <Switch.Thumb className="hb-toggle__thumb" />
      </Switch.Root>
    </div>
  );
}
