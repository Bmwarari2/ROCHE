"use client";

import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * What went wrong, on the page a request came back to (a pack that could not be printed), taking
 * focus so it is heard: an alert already on a newly loaded page is often not announced (WCAG 4.1.3
 * and 2.4.3). The warning counterpart of ArrivalNotice.
 */
export function FocusedWarning({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="m-0 flex max-w-prose items-start gap-2 font-semibold"
      data-focused-warning=""
    >
      <TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
