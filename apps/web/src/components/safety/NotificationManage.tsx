"use client";

import { Button, TextArea, TextField } from "@harbour/ui";
import { CircleAlert, Info } from "lucide-react";
import type { FormEvent } from "react";
import {
  markNotificationNotRequired,
  prepareNotification,
  submitNotification,
} from "@/app/actions/incidents";
import { useFieldIds } from "@/components/care/form-state";
import { Notice } from "@/components/care/Notice";
import { WhenField } from "@/components/care/WhenField";
import { characterCount, t } from "@/lib/i18n";
import {
  CONTENT_MAX,
  type ContentField,
  NEEDED_REASON_MIN,
  type NotificationManageView,
  REFERENCE_MAX,
  readPrepareForm,
  readSubmitForm,
} from "@/lib/incident-review";
import { errorFor, partsFor } from "@/lib/outcome";
import { ManageFeedback, ReasonForm, useManageSend } from "./ManageForms";

interface Target {
  readonly id: string;
  readonly incidentId: string | null;
  readonly version: number;
  readonly status: string;
  readonly kind?: string;
}

/**
 * A duty of candour notification goes to the person, not a regulator (review H2): its evidence is
 * the written notification's copy on the candour record, or null when there is none yet.
 */
export interface CandourEvidence {
  readonly documentId: string | null;
}

const pathOf = (id: string) => `/notifications/statutory/${id}`;

/**
 * Fill in the regulator's form (`safety.incident.manage`): one answer per line of required
 * content, in the API's English, and a free field. Saving a draft keeps what is there; marking it
 * ready needs every line answered. A ready notification can go back to draft.
 */
function PrepareForm({
  target,
  fields,
  content,
}: {
  readonly target: Target;
  readonly fields: readonly ContentField[];
  readonly content: Readonly<Record<string, string>>;
}) {
  const ids = useFieldIds(fields.map((f) => f.name));
  const { result, pending, send, fail } = useManageSend(pathOf(target.id));
  const ready = target.status === "ready";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const markReady = submitter?.getAttribute("value") !== "draft";
    const read = readPrepareForm(new FormData(event.currentTarget), fields, markReady, t);
    if (!read.ok) return fail(read.errors);
    const done = markReady ? (ready ? "saved" : "ready") : ready ? "draft" : "saved";
    send(done, () =>
      prepareNotification(target.id, target.incidentId, {
        content: read.content,
        ready: markReady,
        version: target.version,
      }),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="prepare-title"
      >
        <div className="flex flex-col gap-1">
          <h3 id="prepare-title" className="m-0 text-body font-semibold">
            {t("safety.manage.prepare.title")}
          </h3>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("safety.manage.prepare.intro")}
          </p>
        </div>
        {fields.map((field) => {
          const error = errorFor(result, field.name);
          return (
            <TextArea
              key={field.name}
              id={ids[field.name]}
              name={field.name}
              label={field.line ?? t("safety.manage.prepare.notes")}
              {...(field.line === null ? {} : { labelLang: "en-GB" })}
              hint={
                field.line === null
                  ? t("safety.manage.prepare.notesHint")
                  : t("safety.manage.prepare.lineHint")
              }
              rows={3}
              required={field.line !== null}
              maxLength={CONTENT_MAX}
              formatCount={(remaining) => characterCount(remaining)}
              defaultValue={content[field.key] ?? ""}
              {...(error ? { error } : {})}
            />
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" value="ready" disabled={pending}>
            {pending
              ? t("common.saving")
              : t("safety.manage.prepare.submit", { action: ready ? "save" : "ready" })}
          </Button>
          <Button type="submit" value="draft" variant="secondary" disabled={pending}>
            {t("safety.manage.prepare.submit", { action: ready ? "toDraft" : "draft" })}
          </Button>
        </div>
      </form>
      <ManageFeedback result={result} path={pathOf(target.id)} fieldIds={ids} />
    </div>
  );
}

const SUBMIT_FIELDS = ["submittedAt", "externalReference"] as const;

/**
 * Record that a ready notification was submitted on the regulator's own portal
 * (`safety.notification.submit`, step-up): when, chosen every time, and the regulator's reference.
 */
function SubmitForm({
  target,
  candour,
}: {
  readonly target: Target;
  /** For a duty of candour notification: its evidence, never a regulator's reference. */
  readonly candour?: CandourEvidence;
}) {
  const ids = useFieldIds(SUBMIT_FIELDS);
  const path = pathOf(target.id);
  const { result, pending, send, fail } = useManageSend(path);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readSubmitForm(new FormData(event.currentTarget), new Date(), t, {
      reference: !candour,
    });
    if (!read.ok) return fail(read.errors, read.parts);
    send("submitted", () =>
      submitNotification(target.id, target.incidentId, {
        submittedAt: read.submittedAt,
        externalReference: candour ? "" : read.externalReference,
        evidenceDocumentId: candour?.documentId ?? null,
        version: target.version,
      }),
    );
  };
  // Without the written notification's copy there is nothing to record it with yet.
  if (candour && !candour.documentId) {
    return (
      <Notice
        icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
        title={t("safety.manage.submit.title")}
      >
        <p className="m-0">{t("safety.manage.submit.candourFirst")}</p>
        {target.incidentId ? (
          <a href={`/incidents/${target.incidentId}#candour`} className="underline">
            {t("safety.manage.submit.candourLink")}
          </a>
        ) : null}
      </Notice>
    );
  }

  const referenceError = errorFor(result, "externalReference");
  const whenError = errorFor(result, "submittedAt");
  const whenParts = partsFor(result, "submittedAt");
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="submit-title"
      >
        <div className="flex flex-col gap-1">
          <h3 id="submit-title" className="m-0 text-body font-semibold">
            {t("safety.manage.submit.title")}
          </h3>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {candour ? t("safety.manage.submit.candourIntro") : t("safety.manage.submit.intro")}
          </p>
        </div>
        <WhenField
          name="submittedAt"
          legend={t("safety.manage.submit.when")}
          id={ids.submittedAt}
          {...(whenError ? { error: whenError } : {})}
          {...(whenParts ? { errorParts: whenParts } : {})}
          explicit={{
            hint: t("safety.manage.submit.whenHint"),
            now: {
              label: t("safety.record.when", { when: "now" }),
              description: t("safety.manage.submit.whenDescription", { when: "now" }),
            },
            earlier: {
              label: t("safety.record.when", { when: "earlier" }),
              description: t("safety.manage.submit.whenDescription", { when: "earlier" }),
            },
          }}
        />
        {candour ? null : (
          <TextField
            id={ids.externalReference}
            name="externalReference"
            label={t("safety.manage.submit.reference")}
            hint={t("safety.manage.submit.referenceHint")}
            required
            maxLength={REFERENCE_MAX}
            autoComplete="off"
            {...(referenceError ? { error: referenceError } : {})}
          />
        )}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("safety.manage.submit.submit")}
          </Button>
        </div>
      </form>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

/**
 * The manager's forms on a statutory notification (safety.md section 3; SAFE-002 and SAFE-003;
 * HZ-013), each only where `notificationManageView` offers it: prepare it, record that it was
 * submitted, or decide it is not required with a reason. Submitting and "not required" need a
 * fresh sign-in; the API checks every rule again.
 */
export function NotificationManage({
  target,
  judgedNeeded,
  view,
  fields,
  content,
  candour,
}: {
  readonly target: Target;
  /**
   * Harbour found it needed (neither provisional nor no longer indicated): "not required" then
   * says so, takes a longer reason and asks for a confirmation (HZ-013).
   */
  readonly judgedNeeded: boolean;
  readonly view: NotificationManageView;
  readonly fields: readonly ContentField[];
  readonly content: Readonly<Record<string, string>>;
  /** For a duty of candour notification, its evidence from the candour record. */
  readonly candour?: CandourEvidence;
}) {
  return (
    <div className="flex flex-col gap-8">
      {view.prepare ? <PrepareForm target={target} fields={fields} content={content} /> : null}
      {view.submit ? <SubmitForm target={target} {...(candour ? { candour } : {})} /> : null}
      {/* Someone who may submit, on a draft: the workflow submits only a ready notification. */}
      {!view.submit && view.notRequired ? (
        <Notice
          icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("safety.manage.submit.title")}
        >
          {t("safety.manage.submit.notReady")}
        </Notice>
      ) : null}
      {view.notRequired ? (
        <ReasonForm
          title={t("safety.manage.notRequired.title")}
          intro={t("safety.manage.notRequired.intro")}
          label={t("safety.manage.notRequired.label")}
          hint={t("safety.manage.notRequired.hint")}
          purpose={judgedNeeded ? "notRequiredNeeded" : "notRequired"}
          submit={t("safety.manage.notRequired.submit")}
          path={pathOf(target.id)}
          done="notRequired"
          destructive
          {...(judgedNeeded
            ? { min: NEEDED_REASON_MIN, confirm: t("safety.manage.notRequired.confirm") }
            : {})}
          onSend={(reason) =>
            markNotificationNotRequired(target.id, target.incidentId, {
              reason,
              version: target.version,
            })
          }
        >
          {judgedNeeded ? (
            <Notice
              tone="warning"
              icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
              title={t("safety.manage.notRequired.needed")}
            >
              {t("safety.manage.notRequired.neededHint")}
            </Notice>
          ) : null}
        </ReasonForm>
      ) : null}
    </div>
  );
}
