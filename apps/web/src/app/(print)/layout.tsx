import type { ReactNode } from "react";

/**
 * Print views (medicines.md section 15 rule 7): the page alone, with no menu or record tabs, on a
 * white background, so what prints is the record. Signed-in pages still: each view reads the API
 * as the signed-in person.
 */
export default function PrintLayout({ children }: { readonly children: ReactNode }) {
  return <div className="min-h-dvh bg-bg p-4 text-text print:p-0">{children}</div>;
}
