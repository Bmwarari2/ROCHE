"use client";

import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * Says, on the page the invite went to, that the email could not be sent, and takes focus there
 * as ArrivalNotice does, so the warning is heard rather than missed (WCAG 4.1.3 and 2.4.3).
 */
export function EmailFailedNotice({ children }: { readonly children: ReactNode }) {
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
