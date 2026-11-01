"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { Notice } from "@/components/care/Notice";

/**
 * A problem the page arrived with (for example a PDF that could not be made): a warning notice
 * with an icon and words, in an alert, that takes focus once so keyboard and screen reader users
 * hear it at once (WCAG 4.1.3, 2.4.3).
 */
export function FocusedAlert({ title }: { readonly title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} role="alert" tabIndex={-1}>
      <Notice
        tone="warning"
        icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
        title={title}
      />
    </div>
  );
}
