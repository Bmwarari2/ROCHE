import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A warning in words with its icon (CONTENT.md: status never by colour or weight alone). `alert`
 * for something that went wrong on this page; a notice that must be heard after a page load takes
 * focus instead (`FocusedWarning`).
 */
export function WarningLine({
  children,
  alert = false,
  ...rest
}: {
  readonly children: ReactNode;
  readonly alert?: boolean;
  readonly [data: `data-${string}`]: string;
}) {
  return (
    <p
      {...(alert ? { role: "alert" } : {})}
      className="m-0 flex max-w-prose items-start gap-2 font-semibold"
      {...rest}
    >
      <TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
