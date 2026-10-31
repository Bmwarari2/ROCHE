"use client";

import { discardEvidencePack, revokeEvidencePack } from "@/app/actions/quality";
import { t } from "@/lib/i18n";
import { QualityReasonForm } from "./QualityForms";

/**
 * Withdraw a released pack (its link stops at once and the bundle is deleted) or discard a draft
 * (`quality.evidence_pack.compose`, with a reason). Withdrawing access can only make things safer,
 * so the pack's composers may always revoke.
 */
export function PackEndForms({
  packId,
  version,
  path,
  revoke,
  discard,
}: {
  readonly packId: string;
  readonly version: number;
  readonly path: string;
  readonly revoke: boolean;
  readonly discard: boolean;
}) {
  if (!revoke && !discard) return null;
  return (
    <section aria-labelledby="end-title" className="flex flex-col gap-4">
      <h2 id="end-title" className="m-0 text-heading-3 font-semibold">
        {t("quality.end.title", { action: revoke ? "revoke" : "discard" })}
      </h2>
      {revoke ? (
        <QualityReasonForm
          title={t("quality.end.formTitle", { action: "revoke" })}
          intro={t("quality.end.intro", { action: "revoke" })}
          label={t("quality.end.reason")}
          hint={t("quality.end.reasonHint", { action: "revoke" })}
          submit={t("quality.end.submit", { action: "revoke" })}
          path={path}
          done="revoked"
          onSend={(reason) => revokeEvidencePack(packId, { reason, version })}
        />
      ) : null}
      {discard ? (
        <QualityReasonForm
          title={t("quality.end.formTitle", { action: "discard" })}
          intro={t("quality.end.intro", { action: "discard" })}
          label={t("quality.end.reason")}
          hint={t("quality.end.reasonHint", { action: "discard" })}
          submit={t("quality.end.submit", { action: "discard" })}
          path={path}
          done="discarded"
          onSend={(reason) => discardEvidencePack(packId, { reason, version })}
        />
      ) : null}
    </section>
  );
}
