"use client";

import type {
  AuditQuestion,
  AuditRecordDetail,
  AuditStarter,
  AuditTemplateItem,
  EvidenceLinkItem,
  FrameworkMappingView,
  FrameworkVersionDetail,
} from "@harbour/contracts";
import {
  Button,
  Checkbox,
  DateInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { type FormEvent, useMemo } from "react";
import {
  addAuditTemplate,
  completeAudit,
  retireAuditTemplate,
  saveAuditAnswers,
  saveMapping,
  scheduleAudit,
  startAudit,
  tagEvidence,
  untagEvidence,
} from "@/app/actions/quality-programme";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import {
  ACTION_DESCRIPTION_MAX,
  ANSWERS,
  actionField,
  answerField,
  MAPPING_OWNER_MAX,
  MAPPING_TITLE_MAX,
  mappingField,
  needsAction,
  readAnswers,
  readCompletion,
  readMapping,
  readTag,
  selfRatingChoices,
  statementRows,
} from "@/lib/quality-programme";
import { dateBoxesOf, readDateField } from "@/lib/uk-time";
import { QualityFeedback, QualityReasonForm, useQualitySend } from "./QualityForms";

/**
 * The forms of the framework, evidence library and audit programme screens (quality.md section
 * 20). Each is a plain HTML form posted to the page until it hydrates (`method="post"`), then sent
 * through a server action; every problem is said at its field and in a summary that links to it.
 */

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

function FormHeading({ id, title, intro }: { id: string; title: string; intro?: string }) {
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

// ---------------------------------------------------------------------------------------------
// The mapping editor

export function MappingForm({
  frameworkId,
  detail,
  mapping,
  path,
}: {
  readonly frameworkId: string;
  readonly detail: FrameworkVersionDetail;
  readonly mapping: FrameworkMappingView;
  readonly path: string;
}) {
  const rows = useMemo(() => statementRows(detail), [detail]);
  const keys = useMemo(
    () => ["form", ...rows.flatMap((s) => [mappingField.title(s.id), mappingField.owner(s.id)])],
    [rows],
  );
  const ids = useFieldIds(keys);
  const { result, pending, send, fail } = useQualitySend(path);
  const current = new Map(mapping.entries.map((e) => [e.statementId, e]));
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readMapping(new FormData(event.currentTarget), detail, t);
    if (!read.ok) return fail(read.errors);
    send("mapped", () =>
      saveMapping(frameworkId, {
        mappingVersion: mapping.mappingVersion + 1,
        entries: read.entries,
      }),
    );
  };
  const titleId = `${ids.form}-title`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-6"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <FormHeading
          id={titleId}
          title={t("quality.mapping.formTitle")}
          intro={t("quality.mapping.formIntro", { version: mapping.mappingVersion })}
        />
        {detail.keyQuestions.map((question) => (
          <fieldset key={question.id} className="m-0 flex flex-col gap-4 border-0 p-0">
            <legend className="mb-2 text-heading-3 font-semibold">{question.title}</legend>
            {question.statements.map((statement) => {
              const entry = current.get(statement.id);
              return (
                <fieldset
                  key={statement.id}
                  className="m-0 flex flex-col gap-3 rounded-card border border-border p-4"
                >
                  <legend className="px-1 font-semibold">{statement.title}</legend>
                  <TextField
                    id={ids[mappingField.title(statement.id)]}
                    name={mappingField.title(statement.id)}
                    label={t("quality.mapping.localTitle")}
                    hint={t("quality.mapping.localTitleHint")}
                    defaultValue={entry?.localTitle ?? ""}
                    maxLength={MAPPING_TITLE_MAX}
                    error={errorFor(result, mappingField.title(statement.id))}
                  />
                  <TextField
                    id={ids[mappingField.owner(statement.id)]}
                    name={mappingField.owner(statement.id)}
                    label={t("quality.mapping.owner")}
                    hint={t("quality.mapping.ownerHint")}
                    defaultValue={entry?.ownerRole ?? ""}
                    maxLength={MAPPING_OWNER_MAX}
                    className="max-w-sm"
                    error={errorFor(result, mappingField.owner(statement.id))}
                  />
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-1 text-body-dense">
                      {t("quality.mapping.categories")}
                    </legend>
                    {detail.evidenceCategories.map((category) => (
                      <Checkbox
                        key={category.id}
                        name={mappingField.category(statement.id)}
                        value={category.id}
                        label={category.title}
                        defaultChecked={entry?.evidenceCategoryIds.includes(category.id) ?? false}
                      />
                    ))}
                  </fieldset>
                </fieldset>
              );
            })}
          </fieldset>
        ))}
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.mapping.save")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Evidence tagging

export function TagForm({
  recordType,
  recordId,
  detail,
  path,
}: {
  readonly recordType: string;
  readonly recordId: string;
  readonly detail: FrameworkVersionDetail;
  readonly path: string;
}) {
  const ids = useFieldIds(["statement"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readTag(new FormData(event.currentTarget), detail, t);
    if (!read.ok) return fail(read.errors);
    send("tagged", () =>
      tagEvidence({
        recordType,
        recordId,
        frameworkVersionId: detail.id,
        statementIds: read.statementIds,
      }),
    );
  };
  const titleId = `${ids.statement}-title`;
  const error = errorFor(result, "statement");
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <FormHeading
          id={titleId}
          title={t("quality.tag.formTitle")}
          intro={t("quality.tag.intro")}
        />
        <div
          id={ids.statement}
          tabIndex={-1}
          className="flex flex-col gap-4"
          {...(error ? { "aria-describedby": `${ids.statement}-error` } : {})}
        >
          {error ? (
            <p id={`${ids.statement}-error`} className="m-0 font-semibold text-status-overdue-text">
              {error}
            </p>
          ) : null}
          {detail.keyQuestions.map((question) => (
            <fieldset key={question.id} className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1 font-semibold">{question.title}</legend>
              {question.statements.map((statement) => (
                <Checkbox
                  key={statement.id}
                  name="statement"
                  value={statement.id}
                  label={statement.title}
                />
              ))}
            </fieldset>
          ))}
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.tag.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function UntagForm({
  link,
  path,
}: {
  readonly link: EvidenceLinkItem;
  readonly path: string;
}) {
  return (
    <QualityReasonForm
      title={t("quality.tag.removeTitle")}
      intro={t("quality.tag.removeIntro")}
      label={t("quality.tag.removeReason")}
      hint={t("quality.tag.removeHint")}
      submit={t("quality.tag.remove")}
      path={path}
      done="untagged"
      onSend={(reason) => untagEvidence(link.id, { reason, version: link.version })}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Templates and schedules

export function StarterForm({ starters }: { readonly starters: readonly AuditStarter[] }) {
  const ids = useFieldIds(["starterKey", "key"]);
  const path = "/quality/audits/templates";
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const starterKey = String(data.get("starterKey") ?? "");
    const key = String(data.get("key") ?? "").trim() || starterKey;
    const errors: Record<string, string> = {};
    if (!starters.some((s) => s.key === starterKey))
      errors.starterKey = t("quality.templates.chooseStarter");
    if (!/^[a-z0-9_-]{1,64}$/.test(key)) errors.key = t("quality.templates.keyInvalid");
    if (Object.keys(errors).length > 0) return fail(errors);
    send(
      (data: { id: string }) =>
        `/quality/audits/templates/${data.id}?done=templateAdded&at=${Date.now()}`,
      () => addAuditTemplate({ key, starterKey }),
    );
  };
  const titleId = `${ids.key}-title`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <FormHeading
          id={titleId}
          title={t("quality.templates.addTitle")}
          intro={t("quality.templates.addIntro")}
        />
        <SelectField
          id={ids.starterKey}
          name="starterKey"
          label={t("quality.templates.starter")}
          emptyOption={t("quality.templates.chooseStarter")}
          options={starters.map((s) => ({ value: s.key, label: s.title }))}
          className="max-w-md"
          error={errorFor(result, "starterKey")}
        />
        <TextField
          id={ids.key}
          name="key"
          label={t("quality.templates.key")}
          hint={t("quality.templates.keyHint")}
          className="max-w-sm"
          maxLength={64}
          error={errorFor(result, "key")}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.templates.add")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function RetireTemplateForm({
  template,
  path,
}: {
  readonly template: AuditTemplateItem;
  readonly path: string;
}) {
  const ids = useFieldIds(["confirm"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (new FormData(event.currentTarget).get("confirm") !== "yes") {
      return fail({ confirm: t("quality.end.confirmError") });
    }
    send("templateRetired", () => retireAuditTemplate(template.id, template.version));
  };
  const titleId = `${ids.confirm}-title`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <FormHeading
          id={titleId}
          title={t("quality.templates.retireTitle")}
          intro={t("quality.templates.retireIntro")}
        />
        <Checkbox
          id={ids.confirm}
          name="confirm"
          value="yes"
          label={t("quality.templates.retireConfirm")}
          required
          error={errorFor(result, "confirm")}
        />
        <div>
          <Button type="submit" variant="destructive" disabled={pending}>
            {pending ? t("common.saving") : t("quality.templates.retire")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function ScheduleForm({
  templateId,
  locations,
  path,
}: {
  readonly templateId: string;
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly path: string;
}) {
  const ids = useFieldIds(["locationId", "frequencyMonths", "firstDueOn"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const locationId = String(data.get("locationId") ?? "");
    const frequency = Number(data.get("frequencyMonths"));
    const due = readDateField(data, "firstDueOn", {
      subject: t("quality.schedule.firstDueSubject"),
      t,
    });
    const errors: Record<string, string> = {};
    const parts: Record<string, readonly string[]> = {};
    if (!locations.some((l) => l.id === locationId))
      errors.locationId = t("quality.schedule.chooseLocation");
    if (!Number.isInteger(frequency) || frequency < 1 || frequency > 60) {
      errors.frequencyMonths = t("quality.schedule.frequencyInvalid");
    }
    if (!due.ok) {
      errors.firstDueOn = due.message;
      parts.firstDueOn = due.parts;
    }
    if (Object.keys(errors).length > 0 || !due.ok || !due.date) return fail(errors, parts);
    const firstDueOn = due.date;
    send("scheduled", () =>
      scheduleAudit({ templateId, locationId, frequencyMonths: frequency, firstDueOn }),
    );
  };
  const titleId = `${ids.locationId}-title`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <FormHeading
          id={titleId}
          title={t("quality.schedule.formTitle")}
          intro={t("quality.schedule.formIntro")}
        />
        <SelectField
          id={ids.locationId}
          name="locationId"
          label={t("quality.schedule.location")}
          emptyOption={t("quality.schedule.chooseLocation")}
          options={locations.map((l) => ({ value: l.id, label: l.name }))}
          className="max-w-md"
          error={errorFor(result, "locationId")}
        />
        <TextField
          id={ids.frequencyMonths}
          name="frequencyMonths"
          type="number"
          inputMode="numeric"
          label={t("quality.schedule.frequency")}
          hint={t("quality.schedule.frequencyHint")}
          className="max-w-xs"
          error={errorFor(result, "frequencyMonths")}
        />
        <DateInput
          id={ids.firstDueOn}
          name="firstDueOn"
          legend={t("quality.schedule.firstDue")}
          hint={t("care.date.hint")}
          labels={dateLabels}
          error={errorFor(result, "firstDueOn")}
          errorParts={dateBoxesOf(partsFor(result, "firstDueOn"))}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.schedule.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Running an audit

export function StartAuditForm({
  templates,
  locations,
  defaultLocationId,
  today,
}: {
  readonly templates: readonly AuditTemplateItem[];
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly defaultLocationId: string | null;
  readonly today: string;
}) {
  const ids = useFieldIds(["templateId", "locationId", "auditedOn"]);
  const path = "/quality/audits/new";
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const templateId = String(data.get("templateId") ?? "");
    const locationId = String(data.get("locationId") ?? "");
    const on = readDateField(data, "auditedOn", {
      subject: t("quality.start.auditedOnSubject"),
      t,
    });
    const errors: Record<string, string> = {};
    const parts: Record<string, readonly string[]> = {};
    if (!templates.some((tpl) => tpl.id === templateId))
      errors.templateId = t("quality.start.chooseTemplate");
    if (!locations.some((l) => l.id === locationId))
      errors.locationId = t("quality.schedule.chooseLocation");
    if (!on.ok) {
      errors.auditedOn = on.message;
      parts.auditedOn = on.parts;
    } else if (on.date && on.date > today) {
      errors.auditedOn = t("quality.start.auditedOnFuture");
    }
    if (Object.keys(errors).length > 0 || !on.ok || !on.date) return fail(errors, parts);
    const auditedOn = on.date;
    send(
      (data: { id: string }) => `/quality/audits/${data.id}?done=started&at=${Date.now()}`,
      () => startAudit({ templateId, locationId, auditedOn }),
    );
  };
  const titleId = `${ids.templateId}-title`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <FormHeading
          id={titleId}
          title={t("quality.start.formTitle")}
          intro={t("quality.start.intro")}
        />
        <SelectField
          id={ids.templateId}
          name="templateId"
          label={t("quality.start.template")}
          emptyOption={t("quality.start.chooseTemplate")}
          options={templates.map((tpl) => ({
            value: tpl.id,
            label: t("quality.start.templateOption", { title: tpl.title, kind: tpl.kind }),
          }))}
          className="max-w-md"
          error={errorFor(result, "templateId")}
        />
        <SelectField
          id={ids.locationId}
          name="locationId"
          label={t("quality.schedule.location")}
          emptyOption={t("quality.schedule.chooseLocation")}
          defaultValue={defaultLocationId ?? ""}
          options={locations.map((l) => ({ value: l.id, label: l.name }))}
          className="max-w-md"
          error={errorFor(result, "locationId")}
        />
        <DateInput
          id={ids.auditedOn}
          name="auditedOn"
          legend={t("quality.start.auditedOn")}
          hint={t("care.date.hint")}
          labels={dateLabels}
          defaultValue={today}
          error={errorFor(result, "auditedOn")}
          errorParts={dateBoxesOf(partsFor(result, "auditedOn"))}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.start.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function AnswersForm({
  audit,
  path,
}: {
  readonly audit: AuditRecordDetail;
  readonly path: string;
}) {
  const ids = useFieldIds(["form", ...audit.questions.map((q) => answerField(q.key))]);
  const { result, pending, send } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answers = readAnswers(new FormData(event.currentTarget), audit.questions);
    send("answered", () => saveAuditAnswers(audit.id, { version: audit.version, answers }));
  };
  const titleId = `${ids.form}-title`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-6"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <FormHeading
          id={titleId}
          title={t("quality.answers.formTitle")}
          intro={t("quality.answers.intro")}
        />
        {audit.questions.map((question, index) => (
          <RadioGroup
            key={question.key}
            id={ids[answerField(question.key)]}
            name={answerField(question.key)}
            legend={t("quality.answers.question", { n: index + 1, text: question.text })}
            hint={t("quality.answers.questionHint", {
              weight: question.weight,
              actionRequired: String(question.actionRequired),
            })}
            layout="inline"
            {...(audit.answers[question.key]
              ? { defaultValue: audit.answers[question.key] ?? undefined }
              : {})}
            options={ANSWERS.map((value) => ({
              value,
              label: t("quality.answers.answer", { value }),
            }))}
          />
        ))}
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.answers.save")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

export function CompleteAuditForm({
  audit,
  owners,
  path,
}: {
  readonly audit: AuditRecordDetail;
  readonly owners: readonly { readonly id: string; readonly name: string }[];
  readonly path: string;
}) {
  const shortfalls: AuditQuestion[] = needsAction(audit.questions, audit.answers);
  const ids = useFieldIds([
    "selfRating",
    ...shortfalls.flatMap((q) => [
      actionField.description(q.key),
      actionField.owner(q.key),
      actionField.due(q.key),
    ]),
  ]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readCompletion(
      new FormData(event.currentTarget),
      shortfalls,
      owners.map((o) => o.id),
      t,
    );
    if (!read.ok) return fail(read.errors, read.parts);
    send("auditCompleted", () => completeAudit(audit.id, { version: audit.version, ...read.body }));
  };
  const titleId = `${ids.selfRating}-title`;
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-6"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={titleId}
      >
        <FormHeading
          id={titleId}
          title={t("quality.complete.formTitle")}
          intro={t("quality.complete.intro")}
        />
        {shortfalls.map((question) => (
          <fieldset
            key={question.key}
            className="m-0 flex flex-col gap-3 rounded-card border border-border p-4"
          >
            <legend className="px-1 font-semibold">
              {t("quality.complete.actionFor", { text: question.text })}
            </legend>
            <TextArea
              id={ids[actionField.description(question.key)]}
              name={actionField.description(question.key)}
              label={t("quality.complete.actionDescription")}
              rows={3}
              maxLength={ACTION_DESCRIPTION_MAX}
              formatCount={(remaining) => characterCount(remaining)}
              error={errorFor(result, actionField.description(question.key))}
            />
            <SelectField
              id={ids[actionField.owner(question.key)]}
              name={actionField.owner(question.key)}
              label={t("quality.complete.owner")}
              emptyOption={t("quality.complete.chooseOwner")}
              options={owners.map((o) => ({ value: o.id, label: o.name }))}
              className="max-w-md"
              error={errorFor(result, actionField.owner(question.key))}
            />
            <DateInput
              id={ids[actionField.due(question.key)]}
              name={actionField.due(question.key)}
              legend={t("quality.complete.due")}
              hint={t("quality.complete.dueHint")}
              labels={dateLabels}
              error={errorFor(result, actionField.due(question.key))}
              errorParts={dateBoxesOf(partsFor(result, actionField.due(question.key)))}
            />
          </fieldset>
        ))}
        <RadioGroup
          id={ids.selfRating}
          name="selfRating"
          legend={t("quality.complete.selfRating")}
          hint={t("quality.complete.selfRatingHint")}
          options={selfRatingChoices(t)}
          error={errorFor(result, "selfRating")}
        />
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? t("common.saving") : t("quality.complete.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}
