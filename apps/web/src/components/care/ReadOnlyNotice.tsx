import { Lock } from "lucide-react";

/**
 * Says, in words, why the record offers no form to record in (ADR-0071 review round 2, C2-M2): it
 * is open to the viewer for reading only. Shown where the form would be; the icon only repeats the
 * words.
 */
export function ReadOnlyNotice({ text }: { readonly text: string }) {
  return (
    <p
      className="m-0 flex max-w-prose items-start gap-2 text-text-secondary"
      data-testid="read-only-notice"
    >
      <Lock size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}
