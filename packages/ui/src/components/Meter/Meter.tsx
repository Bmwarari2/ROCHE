import { type HTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../../lib/cx";

export interface MeterProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** What is measured: "Fluid intake today". */
  label: string;
  value: number;
  /** The end of the bar, for example the daily target. Values beyond it fill the bar. */
  max: number;
  /** The value in words, shown and announced: "1,200 ml of a 1,500 ml target". */
  valueText: string;
  /** A line under the bar, for example the shortfall with its status chip. */
  description?: ReactNode;
}

/**
 * A simple horizontal bar for one measured amount against a limit, such as fluid intake against
 * the daily target. The words carry the meaning; the bar only illustrates it. It is a meter (a
 * measurement within a known range), not a progress bar.
 */
export function Meter({
  label,
  value,
  max,
  valueText,
  description,
  className,
  ...rest
}: MeterProps) {
  const labelId = useId();
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const percent = Math.round((clamped / safeMax) * 1000) / 10;
  return (
    <div className={cx("hb-meter", className)} {...rest}>
      <div className="hb-meter__header">
        <span id={labelId} className="hb-meter__label">
          {label}
        </span>
        <span className="hb-meter__value">{valueText}</span>
      </div>
      {/* The native meter is what assistive technology reads; the bar below only draws it. */}
      <meter
        className="hb-visually-hidden"
        aria-labelledby={labelId}
        aria-valuetext={valueText}
        min={0}
        max={safeMax}
        value={clamped}
      />
      <div className="hb-meter__track" aria-hidden="true">
        <span className="hb-meter__fill" style={{ width: `${percent}%` }} />
      </div>
      {description != null ? <div className="hb-meter__description">{description}</div> : null}
    </div>
  );
}
