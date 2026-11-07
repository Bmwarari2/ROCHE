"use client";

import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * A warning said on arrival at a page (for example that a printout could not be made), with a
 * warning icon and words, never a success tick, taking focus
 * as ArrivalNotice does, so it is heard rather than missed (WCAG 4.1.3 and 2.4.3).
 */
export function WarningArrival({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="m-0 inline-flex items-center gap-2 self-start font-semibold"
    >
      <TriangleAlert size={18} strokeWidth={1.5} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
