"use client";

import { CircleCheck } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * Says what just happened on the page a form went to (a care plan published, a risk assessment
 * saved or closed, a record withdrawn), and takes focus there (WCAG 4.1.3 and 2.4.3). A status
 * already on a new page is not announced by screen readers, and the form that was sent is gone,
 * so moving focus to the words is what makes them heard.
 */
export function ArrivalNotice({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p
      ref={ref}
      tabIndex={-1}
      role="status"
      className="m-0 inline-flex items-center gap-2 self-start font-semibold"
      data-arrival-notice=""
    >
      <CircleCheck size={18} strokeWidth={1.5} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
