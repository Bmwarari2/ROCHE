import type { ReactNode } from "react";

/**
 * A boxed notice at the top of a page that must not be missed, such as "This is a draft" or "This
 * version is no longer in use" (HZ-024): an icon, a bold title and the words, never colour alone.
 */
export function Notice({
  icon,
  title,
  children,
  action,
  tone = "info",
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: "info" | "warning";
}) {
  return (
    <div
      className={`flex flex-wrap items-start gap-3 rounded-input border-s-4 bg-bg-secondary p-4 ${
        tone === "warning" ? "border-warning" : "border-accent"
      }`}
    >
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 font-semibold">{title}</p>
        {children != null ? <div className="m-0">{children}</div> : null}
      </div>
      {action != null ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
