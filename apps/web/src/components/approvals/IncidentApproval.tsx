"use client";

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { closeIncident, reviewIncident } from "@/app/actions/incidents";
import { Notice } from "@/components/care/Notice";
import { ReasonForm } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import type { IncidentManageView } from "@/lib/incident-review";

const link = "inline-flex min-h-target items-center underline";

/**
 * Approve closing an incident from the approvals screen, or send it back to open, with a reason
 * each (safety.md rule 11; HZ-013). The same forms and server actions as the incident's own page,
 * coming back here when done. The API refuses the person who raised it and anything still to do
 * first, and says why; when something must be done first this links to the incident instead.
 */
export function IncidentApproval({
  incidentId,
  version,
  view,
  path,
}: {
  /**
   * The approvals page naming this incident, to come back to when done (kept out of this client
   * bundle's imports), so the page can say which incident was closed.
   */
  readonly path: string;
  readonly incidentId: string;
  readonly version: number;
  readonly view: IncidentManageView;
}) {
  return (
    <div className="flex flex-col gap-4">
      {view.close.kind === "form" ? (
        <ReasonForm
          title={t("safety.manage.close.title")}
          intro={t("safety.manage.close.intro")}
          label={t("safety.manage.close.label")}
          hint={t("safety.manage.close.hint")}
          purpose="close"
          submit={t("safety.manage.close.submit")}
          path={path}
          headingLevel={4}
          done="closed"
          onSend={(reason) => closeIncident(incidentId, { reason, version })}
        />
      ) : null}
      {view.close.kind === "blocked" ? (
        <Notice
          icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("safety.manage.close.blocked")}
        >
          <Link href={`/incidents/${incidentId}`} className={link}>
            {t("approvals.incident.blocked")}
          </Link>
        </Notice>
      ) : null}
      {view.review === "open" ? (
        <ReasonForm
          title={t("safety.manage.reopen.title")}
          intro={t("safety.manage.reopen.intro")}
          label={t("safety.manage.reopen.label")}
          hint={t("safety.manage.reopen.hint")}
          purpose="reopen"
          submit={t("safety.manage.reopen.submit")}
          path={path}
          headingLevel={4}
          done="reopened"
          onSend={(reason) => reviewIncident(incidentId, { to: "open", reason, version })}
        />
      ) : null}
    </div>
  );
}
