import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/** Text that screen readers announce but that is not shown on screen. */
export function VisuallyHidden({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("hb-visually-hidden", className)} {...rest} />;
}
