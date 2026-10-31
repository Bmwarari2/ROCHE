"use client";

import { Button, TextField } from "@harbour/ui";
import type { FormEvent } from "react";
import {
  approveStatement,
  discardStatement,
  recordStatementNotification,
  startStatementDraft,
} from "@/app/actions/quality";
import { useFieldIds } from "@/components/care/form-state";
import { WhenField } from "@/components/care/WhenField";
import { t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import { LIMITS, readNotifyForm } from "@/lib/statement-of-purpose";
import { QualityFeedback, QualityReasonForm, useQualitySend } from "./QualityForms";

const PATH = "/quality/statement-of-purpose";

/** Start a revision from the current version (`quality.statement_of_purpose.write`). */
export function StartRevision() {
  const { result, pending, send } = useQualitySend(PATH);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          disabled={pending}
          onClick={() => send("drafted", () => startStatementDraft(null))}
        >
          {pending ? t("common.saving") : t("quality.sop.startRevision")}
        </Button>
      </div>
      <QualityFeedback result={result} path={PATH} />
    </div>
  );
}

/**
 * Approve the draft (`quality.statement_of_purpose.approve`; rule 14): offered only to someone who
 * neither wrote nor edited it, once it is complete. Approval is the revision, so it starts the CQC
 * clock; the page says so beside the button.
 */
export function ApproveStatement({
  id,
  version,
  noticeDays,
}: {
  readonly id: string;
  readonly version: number;
  /** The CQC period from the rate table (`cqc.statement_of_purpose.revision_notice_days`). */
  readonly noticeDays: number | null;
}) {
  const { result, pending, send } = useQualitySend(PATH);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send("approved", () => approveStatement(id, version));
  };
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-3"
        onSubmit={onSubmit}
        aria-labelledby="approve-title"
      >
        <h3 id="approve-title" className="m-0 text-body font-semibold">
          {t("quality.sop.approve.title")}
        </h3>
        <p className="m-0 max-w-prose text-body-dense text-text-secondary">
          {t("quality.sop.approve.intro", {
            known: String(noticeDays !== null),
            days: noticeDays ?? 0,
          })}
        </p>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("quality.sop.approve.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={PATH} />
    </div>
  );
}

export function DiscardStatement({
  id,
  version,
}: {
  readonly id: string;
  readonly version: number;
}) {
  return (
    <QualityReasonForm
      title={t("quality.sop.discard.title")}
      intro={t("quality.sop.discard.intro")}
      label={t("quality.end.reason")}
      hint={t("quality.sop.discard.hint")}
      submit={t("quality.sop.discard.submit")}
      path={PATH}
      done="sopDiscarded"
      onSend={(reason) => discardStatement(id, { reason, version })}
    />
  );
}

const NOTIFY_FIELDS = ["sentAt", "evidence"] as const;

/**
 * Record that a revision was sent to CQC (`safety.notification.submit`, step-up; rule 15): when,
 * chosen every time, and the CQC reference or how it was sent. A time after the due date shows as
 * late; the API refuses a time in the future or before approval.
 */
export function NotifyStatement({
  id,
  versionNumber,
}: {
  readonly id: string;
  readonly versionNumber: number;
}) {
  const ids = useFieldIds(NOTIFY_FIELDS);
  const { result, pending, send, fail } = useQualitySend(PATH);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readNotifyForm(new FormData(event.currentTarget), new Date(), t);
    if (!read.ok) return fail(read.errors, read.parts);
    send("notified", () =>
      recordStatementNotification(id, { sentAt: read.sentAt, evidence: read.evidence }),
    );
  };
  const titleId = `${ids.sentAt}-title`;
  const whenError = errorFor(result, "sentAt");
  const whenParts = partsFor(result, "sentAt");
  const evidenceError = errorFor(result, "evidence");
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <div className="flex flex-col gap-1">
          <h3 id={titleId} className="m-0 text-body font-semibold">
            {t("quality.sop.notify.title", { n: versionNumber })}
          </h3>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("quality.sop.notify.intro")}
          </p>
        </div>
        <WhenField
          name="sentAt"
          legend={t("quality.sop.notify.when")}
          id={ids.sentAt}
          {...(whenError ? { error: whenError } : {})}
          {...(whenParts ? { errorParts: whenParts } : {})}
          explicit={{
            hint: t("quality.sop.notify.whenHint"),
            now: {
              label: t("safety.record.when", { when: "now" }),
              description: t("quality.sop.notify.whenDescription", { when: "now" }),
            },
            earlier: {
              label: t("safety.record.when", { when: "earlier" }),
              description: t("quality.sop.notify.whenDescription", { when: "earlier" }),
            },
          }}
        />
        <TextField
          id={ids.evidence}
          name="evidence"
          label={t("quality.sop.notify.evidence")}
          hint={t("quality.sop.notify.evidenceHint")}
          required
          maxLength={LIMITS.evidence}
          autoComplete="off"
          {...(evidenceError ? { error: evidenceError } : {})}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("quality.sop.notify.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback
        result={result}
        path={PATH}
        fieldIds={ids}
        stepUp={t("quality.sop.notify.stepUp")}
      />
    </div>
  );
}
