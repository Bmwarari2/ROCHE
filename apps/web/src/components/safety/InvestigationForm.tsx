"use client";

import type { InvestigationItem } from "@harbour/contracts";
import { Button, Checkbox, DateInput, SelectField, TextArea } from "@harbour/ui";
import type { FormEvent } from "react";
import { saveInvestigation } from "@/app/actions/incident-follow-up";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import {
  ACTION_STATUSES,
  INVESTIGATION_LIMITS,
  INVESTIGATION_METHODS,
  readInvestigationForm,
} from "@/lib/investigation";
import { errorFor, partsFor } from "@/lib/outcome";
import { dateBoxesOf } from "@/lib/uk-time";
import { ManageFeedback, useManageSend } from "./ManageForms";

const FIELDS = [
  "lead",
  "method",
  "findings",
  "factors",
  "lessons",
  "newAction",
  "newOwner",
  "newDueOn",
] as const;

/**
 * Record an incident's investigation (`safety.incident.manage`; safety.md section 5; SAFE-010;
 * HZ-091): who leads it, the method, the findings, contributing factors and lessons; each
 * action's status, and one new action at a time (an owner and a date make it a task for its
 * owner); publishing the lessons as a bulletin; and completing it, which needs the findings and
 * the lessons. Every save sends the version the page was drawn from (0 starts it).
 */
export function InvestigationForm({
  incidentId,
  record,
  staff,
  actionLabels,
}: {
  readonly incidentId: string;
  readonly record: InvestigationItem | null;
  /** Who can lead it or own an action: the reader, then their team by name. */
  readonly staff: readonly { readonly value: string; readonly label: string }[];
  /** Each action already there, in words (its owner and date), by its position. */
  readonly actionLabels: readonly string[];
}) {
  const ids = useFieldIds(FIELDS);
  const path = `/incidents/${incidentId}`;
  const { result, pending, send, fail } = useManageSend(path);
  const completed = record?.status === "completed";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    const status =
      submitter === "complete"
        ? "completed"
        : submitter === "reopen"
          ? "open"
          : (record?.status ?? "open");
    const read = readInvestigationForm(
      new FormData(event.currentTarget),
      record,
      staff.map((s) => s.value),
      status,
      t,
    );
    if (!read.ok) return fail(read.errors, read.parts);
    const done =
      submitter === "complete"
        ? "investigationCompleted"
        : submitter === "reopen"
          ? "investigationReopened"
          : "investigationSaved";
    send(done, () => saveInvestigation(incidentId, read.input, record?.version ?? 0));
  };
  const error = (field: string) => {
    const message = errorFor(result, field);
    return message ? { error: message } : {};
  };
  const dueParts = dateBoxesOf(partsFor(result, "newDueOn"));
  const staffOptions = staff.map((s) => ({ value: s.value, label: s.label }));

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="investigation-form"
      >
        <div className="flex flex-col gap-1">
          <h3 id="investigation-form" className="m-0 text-body font-semibold">
            {t("safety.investigation.formTitle")}
          </h3>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("safety.investigation.formIntro")}
          </p>
        </div>
        <SelectField
          id={ids.lead}
          name="lead"
          label={t("safety.investigation.label", { field: "lead" })}
          hint={t("safety.investigation.hint", { field: "lead" })}
          emptyOption={t("safety.investigation.nobody")}
          options={staffOptions}
          defaultValue={record?.leadTenantUserId ?? ""}
          {...error("lead")}
        />
        <SelectField
          id={ids.method}
          name="method"
          label={t("safety.investigation.label", { field: "method" })}
          hint={t("safety.investigation.hint", { field: "method" })}
          emptyOption={t("safety.investigation.method", { method: "none" })}
          options={INVESTIGATION_METHODS.map((method) => ({
            value: method,
            label: t("safety.investigation.method", { method }),
          }))}
          defaultValue={record?.method ?? ""}
        />
        <TextArea
          id={ids.findings}
          name="findings"
          label={t("safety.investigation.label", { field: "findings" })}
          hint={t("safety.investigation.hint", { field: "findings" })}
          rows={5}
          maxLength={INVESTIGATION_LIMITS.findings}
          formatCount={(remaining) => characterCount(remaining)}
          defaultValue={record?.findings ?? ""}
          {...error("findings")}
        />
        <TextArea
          id={ids.factors}
          name="factors"
          label={t("safety.investigation.label", { field: "factors" })}
          hint={t("safety.investigation.hint", { field: "factors" })}
          rows={4}
          defaultValue={(record?.contributingFactors ?? []).join("\n")}
          {...error("factors")}
        />
        <TextArea
          id={ids.lessons}
          name="lessons"
          label={t("safety.investigation.label", { field: "lessons" })}
          hint={t("safety.investigation.hint", { field: "lessons" })}
          rows={4}
          maxLength={INVESTIGATION_LIMITS.lessons}
          formatCount={(remaining) => characterCount(remaining)}
          defaultValue={record?.lessons ?? ""}
          {...error("lessons")}
        />
        {(record?.actions ?? []).length > 0 ? (
          <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
            <legend className="mb-1 p-0 font-semibold">
              {t("safety.investigation.label", { field: "actions" })}
            </legend>
            {(record?.actions ?? []).map((action, i) => (
              <SelectField
                key={action.id}
                name={`action-${i}-status`}
                label={actionLabels[i] ?? action.action}
                options={ACTION_STATUSES.map((status) => ({
                  value: status,
                  label: t("safety.investigation.actionStatus", { status }),
                }))}
                defaultValue={action.status}
              />
            ))}
          </fieldset>
        ) : null}
        <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
          <legend className="mb-1 p-0 font-semibold">
            {t("safety.investigation.label", { field: "newActionGroup" })}
          </legend>
          <TextArea
            id={ids.newAction}
            name="newAction"
            label={t("safety.investigation.label", { field: "newAction" })}
            hint={t("safety.investigation.hint", { field: "newAction" })}
            rows={2}
            maxLength={INVESTIGATION_LIMITS.action}
            formatCount={(remaining) => characterCount(remaining)}
            {...error("newAction")}
          />
          <SelectField
            id={ids.newOwner}
            name="newOwner"
            label={t("safety.investigation.label", { field: "newOwner" })}
            hint={t("safety.investigation.hint", { field: "newOwner" })}
            emptyOption={t("safety.investigation.nobody")}
            options={staffOptions}
            defaultValue=""
            {...error("newOwner")}
          />
          <DateInput
            id={ids.newDueOn}
            name="newDueOn"
            legend={t("safety.investigation.label", { field: "newDueOn" })}
            hint={t("safety.investigation.hint", { field: "newDueOn" })}
            labels={{
              day: t("care.date.day"),
              month: t("care.date.month"),
              year: t("care.date.year"),
            }}
            {...error("newDueOn")}
            {...(dueParts ? { errorParts: dueParts } : {})}
          />
        </fieldset>
        {record?.bulletinPublishedAt ? null : (
          <Checkbox
            name="bulletin"
            value="yes"
            label={t("safety.investigation.label", { field: "bulletin" })}
            hint={t("safety.investigation.hint", { field: "bulletin" })}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" value="save" disabled={pending}>
            {pending ? t("common.saving") : t("safety.investigation.submit", { action: "save" })}
          </Button>
          <Button
            type="submit"
            value={completed ? "reopen" : "complete"}
            variant="secondary"
            disabled={pending}
          >
            {t("safety.investigation.submit", { action: completed ? "reopen" : "complete" })}
          </Button>
        </div>
      </form>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}
