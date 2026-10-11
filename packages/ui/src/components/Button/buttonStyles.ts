import { cx } from "../../lib/cx";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "destructive";

export interface ButtonStyleOptions {
  /** primary: accent pill; secondary: grey pill; tertiary: link style with a chevron; destructive: danger pill. */
  variant?: ButtonVariant;
  /** Stretch to the width of the container. */
  fullWidth?: boolean;
}

/**
 * Class names for a button-styled element. Use it to style a framework link (for example Next.js
 * `Link`) as a button. Kept outside the component files so server components can call it.
 */
export function buttonClassName(
  { variant = "primary", fullWidth = false }: ButtonStyleOptions = {},
  className?: string,
): string {
  return cx("hb-button", `hb-button--${variant}`, fullWidth && "hb-button--full", className);
}
