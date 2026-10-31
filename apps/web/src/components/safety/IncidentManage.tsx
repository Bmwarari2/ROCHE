"use client";

import { Button } from "@harbour/ui";
import { CircleAlert, UserRoundX } from "lucide-react";
import Link from "next/link";
import { closeIncident, reviewIncident } from "@/app/actions/incidents";
import { Notice } from "@/components/care/Notice";
import { t } from "@/lib/i18n";
import type { IncidentManageView } from "@/lib/incident-review";
import { ManageFeedback, ReasonForm, useManageSend } from "./ManageForms";

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;
const link = "inline-flex min-h-target items-center underline";

/** "Start the review": one button, no reason needed (the workflow asks none). */
function StartReview({
  incidentId,
  version,
  path,
}: {
  readonly incidentId: string;
  readonly version: number;
  readonly path: string;
}) {
  const { result, pending, send } = useManageSend(path);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-body font-semibold">{t("safety.manage.review.title")}</h3>
      <p className="m-0 max-w-prose text-body-dense text-text-secondary">
        {t("safety.manage.review.intro")}
      </p>
      <div>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            send("reviewing", () => reviewIncident(incidentId, { to: "under_review", version }))
          }
        >
          {pending ? t("common.saving") : t("safety.manage.review.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} />
    </div>
  );
}

/**
 * Review and close an incident (`safety.incident.manage`; safety.md rule 11; HZ-013), as the page
 * offers them (`incidentManageView`): start the review, or send it back to open with a reason;
 * close it with a reason, never by the person who raised it, and only once every notification is
 * submitted or decided, every question answered and the duty of candour record finished.
 * Otherwise it says what to do first, linked.
 */
export function IncidentManage({
  incidentId,
  version,
  view,
  notificationLabels,
}: {
  readonly incidentId: string;
  readonly version: number;
  readonly view: IncidentManageView;
  /** Each notification's name, by kind, in the reader's words. */
  readonly notificationLabels: Readonly<Record<string, string>>;
}) {
  const path = `/incidents/${incidentId}`;
  const close = view.close;
  return (
    <div className="flex flex-col gap-6">
      {view.review === "under_review" ? (
        <StartReview incidentId={incidentId} version={version} path={path} />
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
          done="reopened"
          onSend={(reason) => reviewIncident(incidentId, { to: "open", reason, version })}
        />
      ) : null}
      {close.kind === "form" ? (
        <ReasonForm
          title={t("safety.manage.close.title")}
          intro={t("safety.manage.close.intro")}
          label={t("safety.manage.close.label")}
          hint={t("safety.manage.close.hint")}
          purpose="close"
          submit={t("safety.manage.close.submit")}
          path={path}
          done="closed"
          onSend={(reason) => closeIncident(incidentId, { reason, version })}
        />
      ) : null}
      {close.kind === "raisedByYou" ? (
        <Notice icon={<UserRoundX {...iconProps} />} title={t("safety.manage.close.title")}>
          {t("safety.manage.close.raisedByYou")}
        </Notice>
      ) : null}
      {close.kind === "blocked" ? (
        <Notice icon={<CircleAlert {...iconProps} />} title={t("safety.manage.close.blocked")}>
          <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
            {close.notifications.map((n) => (
              <li key={n.id}>
                <Link href={`/notifications/statutory/${n.id}`} className={link}>
                  {t("safety.manage.close.notification", {
                    kind: notificationLabels[n.kind] ?? n.kind,
                  })}
                </Link>
              </li>
            ))}
            {close.questions > 0 ? (
              <li>
                {/* A native link, so the browser moves focus to the questions' section. */}
                <a href="#notifications" className={link}>
                  {t("safety.manage.close.questions", { count: close.questions })}
                </a>
              </li>
            ) : null}
            {close.candour ? (
              <li>
                <a href="#candour" className={link}>
                  {t("safety.candour.closeFirst")}
                </a>
              </li>
            ) : null}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}
