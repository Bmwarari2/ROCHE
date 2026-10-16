"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { Notice } from "@/components/care/Notice";

/**
 * Says why the pack could not be opened or printed, on the page the person was sent back to, and
 * takes focus there (WCAG 4.1.3 and 2.4.3): the download they asked for did not happen, so moving
 * focus to the words is what makes them heard. An icon and words, never colour alone.
 */
export function PrintRefusal({ title, hint }: { readonly title: string; readonly hint: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} role="alert" tabIndex={-1} data-print-refusal="">
      <Notice
        tone="warning"
        icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
        title={title}
      >
        {hint}
      </Notice>
    </div>
  );
}
