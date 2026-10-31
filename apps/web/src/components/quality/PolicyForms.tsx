"use client";

import type { PolicyItem } from "@harbour/contracts";
import {
  Button,
  Checkbox,
  DateInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import type { FormEvent } from "react";
import {
  createPolicy,
  publishPolicy,
  retirePolicy,
  savePolicyDraft,
  signPolicy,
  startPolicyDraft,
} from "@/app/actions/policies";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import { POLICY_ROLES, readDraft, readNewPolicy, SUMMARY_MAX } from "@/lib/policies";
import { dateBoxesOf } from "@/lib/uk-time";
import { QualityFeedback, QualityReasonForm, useQualitySend } from "./QualityForms";

/**
 * The policy library's forms (quality.md section 22; QUAL-008; HZ-128). Each posts as plain HTML
 * until it hydrates (`method="post"`), then goes through a server action; every problem is said at
 * its field and in a summary that links to it.
 */

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

type Version = PolicyItem["versions"][number];
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

/** The content, roles and review date of a draft, shared by the new policy and draft forms. */
function DraftFields({
  ids,
  result,
  documents,
  version,
  askChange,
}: {
  readonly ids: Readonly<Record<string, string>>;
  readonly result: Parameters<typeof errorFor>[0];
  readonly documents: readonly Document[];
  readonly version: Version | null;
  readonly askChange: boolean;
}) {
  return (
    <>
      {askChange ? (
        <RadioGroup
          id={ids.change}
          name="change"
          legend={t("quality.policies.form.change")}
          hint={t("quality.policies.form.changeHint")}
          {...(version ? { defaultValue: version.change } : {})}
          options={[
            { value: "minor", label: t("quality.policies.change", { change: "minor" }) },
            { value: "major", label: t("quality.policies.change", { change: "major" }) },
          ]}
          error={errorFor(result, "change")}
        />
      ) : null}
      <TextArea
        id={ids.changeSummary}
        name="changeSummary"
        label={t("quality.policies.form.summary")}
        hint={t("quality.policies.form.summaryHint")}
        rows={3}
        maxLength={SUMMARY_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        defaultValue={version?.changeSummary ?? ""}
        error={errorFor(result, "changeSummary")}
      />
      <TextArea
        id={ids.body}
        name="body"
        label={t("quality.policies.form.body")}
        hint={t("quality.policies.form.bodyHint")}
        rows={10}
        defaultValue={version?.body ?? ""}
        error={errorFor(result, "body")}
      />
      {documents.length > 0 ? (
        <SelectField
          id={ids.documentId}
          name="documentId"
          label={t("quality.policies.form.document")}
          emptyOption={t("quality.policies.form.noDocument")}
          defaultValue={version?.documentId ?? ""}
          options={documents.map((d) => ({ value: d.id, label: d.title }))}
          className="max-w-md"
          error={errorFor(result, "documentId")}
        />
      ) : null}
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 font-semibold">{t("quality.policies.form.roles")}</legend>
        <p className="m-0 text-body-dense text-text-secondary">
          {t("quality.policies.form.rolesHint")}
        </p>
        {POLICY_ROLES.map((role) => (
          <Checkbox
            key={role}
            name="roles"
            value={role}
            label={t("quality.policies.role", { role })}
            defaultChecked={version?.roles.includes(role) ?? false}
          />
        ))}
      </fieldset>
      <DateInput
        id={ids.reviewDueOn}
        name="reviewDueOn"
        legend={t("quality.policies.form.reviewDue")}
        hint={t("quality.policies.form.reviewDueHint")}
        labels={dateLabels}
        defaultValue={version?.reviewDueOn ?? ""}
        error={errorFor(result, "reviewDueOn")}
        errorParts={dateBoxesOf(partsFor(result, "reviewDueOn"))}
      />
    </>
  );
}

const DRAFT_FIELDS = ["change", "changeSummary", "body", "documentId", "reviewDueOn"] as const;

export function NewPolicyForm({ documents }: { readonly documents: readonly Document[] }) {
  const ids = useFieldIds(["policyKey", "title", "secondReviewer", ...DRAFT_FIELDS]);
  const path = "/policies/new";
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const own = readNewPolicy(data, t);
    const draft = readDraft(
      data,
      documents.map((d) => d.id),
      t,
      { askChange: false },
    );
    if (!own.ok || !draft.ok) {
      return fail(
        { ...(own.ok ? {} : own.errors), ...(draft.ok ? {} : draft.errors) },
        draft.ok ? {} : draft.parts,
      );
    }
    const { change: _first, ...firstVersion } = draft.draft;
    send(
      (data: { id: string }) => `/policies/${data.id}?done=policyCreated&at=${Date.now()}`,
      () =>
        createPolicy({
          policyKey: own.policyKey,
          title: own.title,
          requireSecondReviewer: own.requireSecondReviewer,
          firstVersion,
        }),
    );
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
          title={t("quality.policies.new.formTitle")}
          intro={t("quality.policies.new.intro")}
        />
        <TextField
          id={ids.title}
          name="title"
          label={t("quality.policies.form.title")}
          error={errorFor(result, "title")}
        />
        <TextField
          id={ids.policyKey}
          name="policyKey"
          label={t("quality.policies.form.key")}
          hint={t("quality.policies.form.keyHint")}
          className="max-w-sm"
          error={errorFor(result, "policyKey")}
        />
        <Checkbox
          id={ids.secondReviewer}
          name="secondReviewer"
          value="yes"
          label={t("quality.policies.form.secondReviewer")}
          hint={t("quality.policies.form.secondReviewerHint")}
          defaultChecked
        />
        <DraftFields
          ids={ids}
          result={result}
          documents={documents}
          version={null}
          askChange={false}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.policies.new.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function StartDraftForm({
  policyId,
  path,
}: {
  readonly policyId: string;
  readonly path: string;
}) {
  const ids = useFieldIds(["change", "changeSummary"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const change = String(data.get("change") ?? "");
    const changeSummary = String(data.get("changeSummary") ?? "").trim();
    const errors: Record<string, string> = {};
    if (change !== "minor" && change !== "major")
      errors.change = t("quality.policies.form.changeMissing");
    if (changeSummary.length < 2) errors.changeSummary = t("quality.policies.form.summaryMissing");
    if (Object.keys(errors).length > 0) return fail(errors);
    send("draftStarted", () => startPolicyDraft(policyId, { change, changeSummary }));
  };
  const titleId = `${ids.change}-heading`;
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
          title={t("quality.policies.draft.startTitle")}
          intro={t("quality.policies.draft.startIntro")}
        />
        <RadioGroup
          id={ids.change}
          name="change"
          legend={t("quality.policies.form.change")}
          hint={t("quality.policies.form.changeHint")}
          options={[
            { value: "minor", label: t("quality.policies.change", { change: "minor" }) },
            { value: "major", label: t("quality.policies.change", { change: "major" }) },
          ]}
          error={errorFor(result, "change")}
        />
        <TextArea
          id={ids.changeSummary}
          name="changeSummary"
          label={t("quality.policies.form.summary")}
          hint={t("quality.policies.form.summaryHint")}
          rows={3}
          maxLength={SUMMARY_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "changeSummary")}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.policies.draft.start")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function EditDraftForm({
  policyId,
  draft,
  documents,
  path,
}: {
  readonly policyId: string;
  readonly draft: Version;
  readonly documents: readonly Document[];
  readonly path: string;
}) {
  const ids = useFieldIds([...DRAFT_FIELDS]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readDraft(
      new FormData(event.currentTarget),
      documents.map((d) => d.id),
      t,
    );
    if (!read.ok) return fail(read.errors, read.parts);
    send("draftSaved", () =>
      savePolicyDraft(policyId, draft.id, { expectedVersion: draft.version, ...read.draft }),
    );
  };
  const titleId = `${ids.change}-heading`;
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
          title={t("quality.policies.draft.editTitle", { n: draft.versionNumber })}
          intro={t("quality.policies.draft.editIntro")}
        />
        <DraftFields ids={ids} result={result} documents={documents} version={draft} askChange />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.policies.draft.save")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function PublishForm({
  policyId,
  draft,
  path,
}: {
  readonly policyId: string;
  readonly draft: Version;
  readonly path: string;
}) {
  const ids = useFieldIds(["confirm"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (new FormData(event.currentTarget).get("confirm") !== "yes") {
      return fail({ confirm: t("quality.policies.publish.confirmMissing") });
    }
    send("policyPublished", () =>
      publishPolicy(policyId, draft.id, { expectedVersion: draft.version }),
    );
  };
  const titleId = `${ids.confirm}-heading`;
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
          title={t("quality.policies.publish.title", { n: draft.versionNumber })}
          intro={t("quality.policies.publish.intro")}
        />
        <Checkbox
          id={ids.confirm}
          name="confirm"
          value="yes"
          label={t("quality.policies.publish.confirm")}
          error={errorFor(result, "confirm")}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.policies.publish.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function RetirePolicyForm({
  policy,
  path,
}: {
  readonly policy: Pick<PolicyItem, "id" | "version" | "title">;
  readonly path: string;
}) {
  return (
    <QualityReasonForm
      title={t("quality.policies.retire.title")}
      intro={t("quality.policies.retire.intro")}
      label={t("quality.policies.retire.reason")}
      hint={t("quality.policies.retire.hint")}
      submit={t("quality.policies.retire.submit")}
      path={path}
      done="policyRetired"
      confirm={t("quality.policies.retire.confirm")}
      onSend={(reason) => retirePolicy(policy.id, { expectedVersion: policy.version, reason })}
    />
  );
}

export function SignForm({
  policyId,
  version,
  path,
}: {
  readonly policyId: string;
  readonly version: Version;
  readonly path: string;
}) {
  const ids = useFieldIds(["confirm"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (new FormData(event.currentTarget).get("confirm") !== "yes") {
      return fail({ confirm: t("quality.policies.sign.confirmMissing") });
    }
    send("policySigned", () => signPolicy(policyId, version.id));
  };
  const titleId = `${ids.confirm}-heading`;
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
          title={t("quality.policies.sign.title", { n: version.versionNumber })}
        />
        <Checkbox
          id={ids.confirm}
          name="confirm"
          value="yes"
          label={t("quality.policies.sign.confirm")}
          error={errorFor(result, "confirm")}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.policies.sign.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}
