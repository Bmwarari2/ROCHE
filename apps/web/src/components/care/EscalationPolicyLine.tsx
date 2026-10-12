import type { EscalationPolicyRef } from "@harbour/contracts";
import { FileText, TriangleAlert } from "lucide-react";
import { t } from "@/lib/i18n";

/**
 * The organisation's escalation policy for a validated tool's result, as the API resolved it for
 * the result's tool, band and location (medical-device boundary rule 4; HZ-012, HZ-014): its title
 * and reference, linking the policy document when one is uploaded. With none configured, or none
 * returned, it says so with an icon: never nothing, and never advice of Harbour's own.
 */
export function EscalationPolicyLine({ policy }: { readonly policy: EscalationPolicyRef | null }) {
  if (policy === null || policy.status === "not_configured") {
    return (
      <p
        className="m-0 flex items-start gap-2 text-body-dense font-semibold"
        data-escalation-policy="not_configured"
      >
        <TriangleAlert size={18} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
        {t("care.escalation.notConfigured")}
      </p>
    );
  }
  const title = policy.reference
    ? t("care.escalation.titleWithReference", {
        title: policy.title,
        reference: policy.reference,
      })
    : policy.title;
  return (
    <p className="m-0 flex items-start gap-2 text-body-dense" data-escalation-policy="configured">
      <FileText size={18} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {t("care.escalation.policy")}{" "}
        {policy.documentId ? (
          <a href={`/documents/${policy.documentId}`} className="text-link">
            {title}
          </a>
        ) : (
          <span className="font-semibold">{title}</span>
        )}
      </span>
    </p>
  );
}
