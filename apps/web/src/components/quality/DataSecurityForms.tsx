"use client";

import { Button, DateInput, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import type { FormEvent } from "react";
import {
  changeAssertion,
  correctSubmission,
  linkEvidence,
  recordAssertion,
  recordCertificate,
  recordSubmission,
  unlinkEvidence,
} from "@/app/actions/data-security";
import { useFieldIds } from "@/components/care/form-state";
import {
  ASSERTION_STATUSES,
  type AssertionStatus,
  CERTIFICATE_KINDS,
  OUTCOMES,
  readAssertion,
  readAssertionStatus,
  readCertificate,
  readSubmission,
} from "@/lib/data-security";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import { dateBoxesOf } from "@/lib/uk-time";
import { QualityFeedback, useQualitySend } from "./QualityForms";

/**
 * The data security evidence forms (quality.md section 22; QUAL-012). Each posts as plain HTML
 * until it hydrates (`method="post"`), then through a server action; problems are said at their
 * fields and in a linked summary.
 */

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

type Document = { readonly id: string; readonly title: string };

function Heading({ id, title, intro }: { id: string; title: string; intro?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 id={id} className="m-0 text-body font-semibold">
        {title}
      </h3>
      {intro ? (
        <p className="m-0 max-w-prose text-body-dense text-text-secondary">{intro}</p>
      ) : null}
    </div>
  );
}

export function AddAssertionForm({
  financialYear,
  path,
}: {
  readonly financialYear: string;
  readonly path: string;
}) {
  const ids = useFieldIds(["assertionRef", "title"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readAssertion(new FormData(event.currentTarget), financialYear, t);
    if (!read.ok) return fail(read.errors);
    send("assertionAdded", () => recordAssertion(read.body));
  };
  const titleId = `${ids.title}-heading`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <Heading
          id={titleId}
          title={t("quality.dataSecurity.assertions.addTitle")}
          intro={t("quality.dataSecurity.assertions.addIntro", { year: financialYear })}
        />
        <TextField
          id={ids.assertionRef}
          name="assertionRef"
          label={t("quality.dataSecurity.form.ref")}
          hint={t("quality.dataSecurity.form.refHint")}
          className="max-w-xs"
          error={errorFor(result, "assertionRef")}
        />
        <TextArea
          id={ids.title}
          name="title"
          label={t("quality.dataSecurity.form.title")}
          rows={2}
          maxLength={500}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "title")}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.dataSecurity.assertions.add")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function AssertionStatusForm({
  assertion,
  path,
}: {
  readonly assertion: {
    readonly id: string;
    readonly assertionRef: string;
    readonly status: AssertionStatus;
    readonly notes: string | null;
    readonly version: number;
  };
  readonly path: string;
}) {
  const ids = useFieldIds(["status", "notes"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readAssertionStatus(new FormData(event.currentTarget), t);
    if (!read.ok) return fail(read.errors);
    send("assertionChanged", () =>
      changeAssertion(assertion.id, { expectedVersion: assertion.version, ...read.body }),
    );
  };
  const titleId = `${ids.status}-heading`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <Heading
          id={titleId}
          title={t("quality.dataSecurity.assertion.changeTitle", { ref: assertion.assertionRef })}
          intro={t("quality.dataSecurity.assertion.changeIntro")}
        />
        <RadioGroup
          id={ids.status}
          name="status"
          legend={t("quality.dataSecurity.form.status")}
          defaultValue={assertion.status}
          options={ASSERTION_STATUSES.map((status) => ({
            value: status,
            label: t("quality.dataSecurity.assertion.status", { status }),
          }))}
          error={errorFor(result, "status")}
        />
        <TextArea
          id={ids.notes}
          name="notes"
          label={t("quality.dataSecurity.form.notes")}
          hint={t("quality.dataSecurity.form.notesHint")}
          rows={3}
          maxLength={4000}
          formatCount={(remaining) => characterCount(remaining)}
          defaultValue={assertion.notes ?? ""}
          error={errorFor(result, "notes")}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.dataSecurity.assertion.save")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function LinkEvidenceForm({
  assertionId,
  assertionRef,
  documents,
  path,
}: {
  readonly assertionId: string;
  readonly assertionRef: string;
  readonly documents: readonly Document[];
  readonly path: string;
}) {
  const ids = useFieldIds(["documentId"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const documentId = String(new FormData(event.currentTarget).get("documentId") ?? "");
    if (!documents.some((d) => d.id === documentId)) {
      return fail({ documentId: t("quality.dataSecurity.form.documentMissing") });
    }
    send("evidenceLinked", () => linkEvidence(assertionId, { documentId }));
  };
  const titleId = `${ids.documentId}-heading`;
  if (documents.length === 0)
    return <p className="m-0">{t("quality.dataSecurity.evidence.noDocuments")}</p>;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <Heading
          id={titleId}
          title={t("quality.dataSecurity.evidence.linkTitle", { ref: assertionRef })}
        />
        <SelectField
          id={ids.documentId}
          name="documentId"
          label={t("quality.dataSecurity.form.document")}
          emptyOption={t("quality.dataSecurity.form.chooseDocument")}
          options={documents.map((d) => ({ value: d.id, label: d.title }))}
          className="max-w-md"
          error={errorFor(result, "documentId")}
        />
        <div>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.dataSecurity.evidence.link")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function UnlinkEvidenceButton({
  assertionId,
  documentId,
  title,
  path,
}: {
  readonly assertionId: string;
  readonly documentId: string;
  readonly title: string;
  readonly path: string;
}) {
  const { result, pending, send } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send("evidenceUnlinked", () => unlinkEvidence(assertionId, documentId));
  };
  return (
    <div className="flex flex-col gap-2">
      <form
        method="post"
        onSubmit={onSubmit}
        aria-label={t("quality.dataSecurity.evidence.unlinkFor", { title })}
      >
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? t("common.saving") : t("quality.dataSecurity.evidence.unlink", { title })}
        </Button>
      </form>
      <QualityFeedback result={result} path={path} />
    </div>
  );
}

function SubmissionFields({
  ids,
  result,
  submittedOn,
  outcome,
  reference,
}: {
  readonly ids: Readonly<Record<string, string>>;
  readonly result: Parameters<typeof errorFor>[0];
  readonly submittedOn?: string;
  readonly outcome?: string;
  readonly reference?: string | null;
}) {
  return (
    <>
      <DateInput
        id={ids.submittedOn}
        name="submittedOn"
        legend={t("quality.dataSecurity.form.submittedOn")}
        hint={t("care.date.hint")}
        labels={dateLabels}
        defaultValue={submittedOn ?? ""}
        error={errorFor(result, "submittedOn")}
        errorParts={dateBoxesOf(partsFor(result, "submittedOn"))}
      />
      <RadioGroup
        id={ids.outcome}
        name="outcome"
        legend={t("quality.dataSecurity.form.outcome")}
        {...(outcome ? { defaultValue: outcome as (typeof OUTCOMES)[number] } : {})}
        options={OUTCOMES.map((value) => ({
          value,
          label: t("quality.dataSecurity.outcome", { outcome: value }),
        }))}
        error={errorFor(result, "outcome")}
      />
      <TextField
        id={ids.reference}
        name="reference"
        label={t("quality.dataSecurity.form.submissionReference")}
        hint={t("quality.dataSecurity.form.optional")}
        defaultValue={reference ?? ""}
        className="max-w-sm"
        error={errorFor(result, "reference")}
      />
    </>
  );
}

export function RecordSubmissionForm({
  financialYear,
  path,
}: {
  readonly financialYear: string;
  readonly path: string;
}) {
  const ids = useFieldIds(["submittedOn", "outcome", "reference"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readSubmission(new FormData(event.currentTarget), t);
    if (!read.ok) return fail(read.errors, read.parts);
    send("submissionRecorded", () => recordSubmission({ financialYear, ...read.body }));
  };
  const titleId = `${ids.outcome}-heading`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <Heading
          id={titleId}
          title={t("quality.dataSecurity.submissions.recordTitle", { year: financialYear })}
          intro={t("quality.dataSecurity.submissions.recordIntro")}
        />
        <SubmissionFields ids={ids} result={result} />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.dataSecurity.submissions.record")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function CorrectSubmissionForm({
  submission,
  path,
}: {
  readonly submission: {
    readonly id: string;
    readonly financialYear: string;
    readonly submittedOn: string;
    readonly outcome: string;
    readonly reference: string | null;
    readonly version: number;
  };
  readonly path: string;
}) {
  const ids = useFieldIds(["submittedOn", "outcome", "reference"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readSubmission(new FormData(event.currentTarget), t);
    if (!read.ok) return fail(read.errors, read.parts);
    send("submissionCorrected", () =>
      correctSubmission(submission.id, { expectedVersion: submission.version, ...read.body }),
    );
  };
  const titleId = `${ids.outcome}-heading`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <Heading
          id={titleId}
          title={t("quality.dataSecurity.submissions.correctTitle", {
            year: submission.financialYear,
          })}
        />
        <SubmissionFields
          ids={ids}
          result={result}
          submittedOn={submission.submittedOn}
          outcome={submission.outcome}
          reference={submission.reference}
        />
        <div>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.dataSecurity.submissions.correct")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function RecordCertificateForm({
  documents,
  path,
}: {
  readonly documents: readonly Document[];
  readonly path: string;
}) {
  const ids = useFieldIds(["kind", "reference", "issuedOn", "expiresOn", "issuer", "documentId"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readCertificate(
      new FormData(event.currentTarget),
      documents.map((d) => d.id),
      t,
    );
    if (!read.ok) return fail(read.errors, read.parts ?? {});
    send("certificateRecorded", () => recordCertificate(read.body));
  };
  const titleId = `${ids.kind}-heading`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <Heading
          id={titleId}
          title={t("quality.dataSecurity.certificates.recordTitle")}
          intro={t("quality.dataSecurity.certificates.recordIntro")}
        />
        <RadioGroup
          id={ids.kind}
          name="kind"
          legend={t("quality.dataSecurity.form.kind")}
          options={CERTIFICATE_KINDS.map((kind) => ({
            value: kind,
            label: t("quality.dataSecurity.kind", { kind }),
          }))}
          error={errorFor(result, "kind")}
        />
        <TextField
          id={ids.reference}
          name="reference"
          label={t("quality.dataSecurity.form.certificateReference")}
          hint={t("quality.dataSecurity.form.certificateReferenceHint")}
          className="max-w-sm"
          error={errorFor(result, "reference")}
        />
        <DateInput
          id={ids.issuedOn}
          name="issuedOn"
          legend={t("quality.dataSecurity.form.issuedOn")}
          hint={t("care.date.hint")}
          labels={dateLabels}
          error={errorFor(result, "issuedOn")}
          errorParts={dateBoxesOf(partsFor(result, "issuedOn"))}
        />
        <DateInput
          id={ids.expiresOn}
          name="expiresOn"
          legend={t("quality.dataSecurity.form.expiresOn")}
          hint={t("quality.dataSecurity.form.expiresHint")}
          labels={dateLabels}
          error={errorFor(result, "expiresOn")}
          errorParts={dateBoxesOf(partsFor(result, "expiresOn"))}
        />
        <TextField
          id={ids.issuer}
          name="issuer"
          label={t("quality.dataSecurity.form.issuer")}
          hint={t("quality.dataSecurity.form.optional")}
          className="max-w-md"
          error={errorFor(result, "issuer")}
        />
        {documents.length > 0 ? (
          <SelectField
            id={ids.documentId}
            name="documentId"
            label={t("quality.dataSecurity.form.copy")}
            emptyOption={t("quality.dataSecurity.form.noCopy")}
            options={documents.map((d) => ({ value: d.id, label: d.title }))}
            className="max-w-md"
            error={errorFor(result, "documentId")}
          />
        ) : null}
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.dataSecurity.certificates.record")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}
