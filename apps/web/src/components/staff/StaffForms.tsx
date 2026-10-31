"use client";

import { Button, Checkbox, DateInput, SelectField, TextArea, TextField } from "@harbour/ui";
import { Save } from "lucide-react";
import { createStaffFile, recordComplianceItem, updateStaffFile } from "@/app/actions/staff";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor } from "@/lib/outcome";
import {
  type ComplianceItemView,
  type ComplianceKind,
  DBS_LEVELS,
  IDENTITY_DOCUMENTS,
  REGISTRATION_BODIES,
  RTW_METHODS,
  readComplianceItem,
  readStaffFile,
  STAFF_PAGE,
  type StaffFileItem,
  type StaffName,
} from "@/lib/staff";
import { dateBoxesOf } from "@/lib/uk-time";
import { useStaffForm } from "./use-staff-form";

export const dateLabels = () => ({
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
});

const icon = <Save size={18} strokeWidth={1.5} aria-hidden="true" />;

/** A date field with its error and the boxes the error is about. */
export function StaffDate({
  id,
  name,
  legend,
  hint,
  result,
  defaultValue,
}: {
  readonly id: string;
  readonly name: string;
  readonly legend: string;
  readonly hint?: string;
  readonly result: ActionResult<unknown> | null;
  readonly defaultValue?: string | null;
}) {
  return (
    <DateInput
      id={id}
      name={name}
      legend={legend}
      {...(hint ? { hint } : {})}
      error={errorFor(result, name)}
      errorParts={dateBoxesOf(partsFor(result, name))}
      defaultValue={defaultValue ?? null}
      labels={dateLabels()}
    />
  );
}

/**
 * What a staff form says after sending: the refusal or the step-up notice. What was saved is said
 * by the page it opens (RecordedArrival), so it survives the form leaving the page.
 */
export function StaffFeedback({
  result,
  path,
  fieldIds,
}: {
  readonly result: ActionResult<unknown> | null;
  readonly path: string;
  readonly fieldIds: Readonly<Record<string, string>>;
}) {
  return <ManageFeedback result={result} path={path} fieldIds={fieldIds} />;
}

const PROFILE_FIELDS = [
  "tenantUserId",
  "jobTitle",
  "locationId",
  "pathwayCategory",
  "registrationBody",
  "previousCareWork",
  "startsOn",
  "leftOn",
  "dateOfBirth",
] as const;

/**
 * A new staff file (choosing the member) or a change to one. Never one's own: the member list
 * leaves the reader out, and the API refuses it anyway.
 */
export function StaffFileForm({
  members,
  locations,
  file,
}: {
  readonly members?: readonly StaffName[];
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly file?: StaffFileItem;
}) {
  const ids = useFieldIds(PROFILE_FIELDS);
  const creating = !file;
  const { result, pending, submit } = useStaffForm(
    (form) => {
      const read = readStaffFile(form, t, creating);
      return read;
    },
    (value) =>
      file
        ? updateStaffFile(file.id, file.version, value)
        : createStaffFile({ ...value, tenantUserId: value.tenantUserId ?? "" }),
    {
      done: creating ? "created" : "saved",
      ...(creating
        ? {
            to: (data) =>
              `${STAFF_PAGE}/${data && typeof data === "object" && "id" in data ? String(data.id) : ""}`,
          }
        : {}),
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {creating ? (
        <SelectField
          id={ids.tenantUserId}
          name="tenantUserId"
          label={t("staff.form.member")}
          hint={t("staff.form.memberHint")}
          emptyOption={t("staff.form.choose")}
          options={(members ?? []).map((m) => ({
            value: m.id,
            label: m.jobTitle
              ? t("staff.member.withJob", { name: m.displayName, job: m.jobTitle })
              : m.displayName,
          }))}
          error={errorFor(result, "tenantUserId")}
        />
      ) : null}
      <TextField
        id={ids.jobTitle}
        name="jobTitle"
        label={t("staff.form.jobTitle")}
        defaultValue={file?.jobTitle ?? ""}
        autoComplete="off"
        error={errorFor(result, "jobTitle")}
      />
      <SelectField
        id={ids.locationId}
        name="locationId"
        label={t("staff.form.location")}
        emptyOption={t("staff.form.noLocation")}
        defaultValue={file?.locationId ?? ""}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
        error={errorFor(result, "locationId")}
      />
      <TextField
        id={ids.pathwayCategory}
        name="pathwayCategory"
        label={t("staff.form.pathway")}
        hint={t("staff.form.pathwayHint")}
        defaultValue={file?.pathwayCategory ?? ""}
        autoComplete="off"
        error={errorFor(result, "pathwayCategory")}
      />
      <SelectField
        id={ids.registrationBody}
        name="registrationBody"
        label={t("staff.form.registrationBody")}
        hint={t("staff.form.registrationBodyHint")}
        emptyOption={t("staff.form.noRegistration")}
        defaultValue={file?.registrationBody ?? ""}
        options={REGISTRATION_BODIES.map((b) => ({
          value: b,
          label: t("staff.registration.body", { body: b }),
        }))}
        error={errorFor(result, "registrationBody")}
      />
      <Checkbox
        id={ids.previousCareWork}
        name="previousCareWork"
        label={t("staff.form.previousCareWork")}
        defaultChecked={file?.previousCareWork ?? false}
      />
      <StaffDate
        id={ids.startsOn}
        name="startsOn"
        legend={t("staff.form.startsOn")}
        result={result}
        defaultValue={file?.startsOn}
      />
      {creating ? null : (
        <StaffDate
          id={ids.leftOn}
          name="leftOn"
          legend={t("staff.form.leftOn")}
          hint={t("staff.form.leftOnHint")}
          result={result}
          defaultValue={file?.leftOn}
        />
      )}
      <StaffDate
        id={ids.dateOfBirth}
        name="dateOfBirth"
        legend={t("staff.form.dateOfBirth")}
        hint={t("staff.form.dateOfBirthHint")}
        result={result}
        defaultValue={file?.dateOfBirth}
      />
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : creating ? t("staff.form.create") : t("staff.form.save")}
        </Button>
      </div>
      <StaffFeedback
        result={result}
        path={file ? `${STAFF_PAGE}/${file.id}` : STAFF_PAGE}
        fieldIds={ids}
      />
    </form>
  );
}

const ITEM_FIELDS = [
  "document",
  "level",
  "issuedOn",
  "number",
  "result",
  "barredListClearOn",
  "updateService",
  "count",
  "qualifications",
  "declaredFit",
  "adjustmentsAgreed",
  "checkedOn",
  "method",
  "permission",
  "expiresOn",
  "body",
  "pin",
  "renewalDueOn",
  "revalidationDueOn",
  "verifiedToday",
  "kind",
] as const;

/**
 * Record one Schedule 3 item. Fields follow the item's kind; a right to work check is added to the
 * ones kept. "Verified today" records the reader as the verifier (never one's own file: the API
 * refuses it).
 */
export function ComplianceItemForm({
  fileId,
  item,
}: {
  readonly fileId: string;
  readonly item: ComplianceItemView;
}) {
  const ids = useFieldIds(ITEM_FIELDS);
  const kind: ComplianceKind = item.kind;
  const detail = item.detail;
  const { result, pending, submit } = useStaffForm(
    (form) => readComplianceItem(form, kind, detail, t),
    (value) => recordComplianceItem(fileId, kind, item.version, value),
    { done: `item-${kind}` },
  );
  const choose = t("staff.form.choose");
  const err = (field: string) => errorFor(result, field);
  const fields = (() => {
    switch (kind) {
      case "identity_with_photo":
        return (
          <SelectField
            id={ids.document}
            name="document"
            label={t("staff.identity.document")}
            emptyOption={choose}
            defaultValue={detail?.kind === kind ? detail.document : ""}
            options={IDENTITY_DOCUMENTS.map((d) => ({
              value: d,
              label: t("staff.identity.kind", { document: d }),
            }))}
            error={err("document")}
          />
        );
      case "dbs_certificate": {
        const cert = detail?.kind === kind ? detail.certificate : null;
        return (
          <>
            <SelectField
              id={ids.level}
              name="level"
              label={t("staff.dbs.level")}
              emptyOption={choose}
              defaultValue={cert?.level ?? ""}
              options={DBS_LEVELS.map((l) => ({
                value: l,
                label: t("staff.dbs.levelName", { level: l }),
              }))}
              error={err("level")}
            />
            <StaffDate
              id={ids.issuedOn}
              name="issuedOn"
              legend={t("staff.dbs.issuedOn")}
              result={result}
              defaultValue={cert?.issuedOn}
            />
            <TextField
              id={ids.number}
              name="number"
              label={t("staff.dbs.number")}
              hint={t("staff.dbs.numberHint")}
              inputMode="numeric"
              autoComplete="off"
              defaultValue={cert?.number ?? ""}
              error={err("number")}
            />
            <SelectField
              id={ids.result}
              name="result"
              label={t("staff.dbs.result")}
              emptyOption={choose}
              defaultValue={cert?.result ?? ""}
              options={(["clear", "information_disclosed"] as const).map((r) => ({
                value: r,
                label: t("staff.dbs.resultName", { result: r }),
              }))}
              error={err("result")}
            />
            <StaffDate
              id={ids.barredListClearOn}
              name="barredListClearOn"
              legend={t("staff.dbs.barredOn")}
              hint={t("staff.dbs.barredHint")}
              result={result}
              defaultValue={detail?.kind === kind ? detail.barredListClearOn : null}
            />
            <Checkbox
              id={ids.updateService}
              name="updateService"
              label={t("staff.dbs.updateService")}
              defaultChecked={
                detail?.kind === kind ? detail.updateService?.subscribed === true : false
              }
            />
          </>
        );
      }
      case "conduct_in_care_work":
      case "references":
        return (
          <TextField
            id={ids.count}
            name="count"
            label={
              kind === "references" ? t("staff.references.received") : t("staff.conduct.contacted")
            }
            inputMode="numeric"
            autoComplete="off"
            defaultValue={
              detail?.kind === "references"
                ? String(detail.received)
                : detail?.kind === "conduct_in_care_work"
                  ? String(detail.employersContacted)
                  : ""
            }
            error={err("count")}
          />
        );
      case "relevant_qualifications":
        return (
          <TextArea
            id={ids.qualifications}
            name="qualifications"
            label={t("staff.qualifications.label")}
            hint={t("staff.qualifications.hint")}
            rows={4}
            maxLength={4000}
            formatCount={(remaining) => characterCount(remaining)}
            defaultValue={detail?.kind === kind ? detail.qualifications.join("\n") : ""}
            error={err("qualifications")}
          />
        );
      case "health_fitness":
        return (
          <>
            <Checkbox
              id={ids.declaredFit}
              name="declaredFit"
              label={t("staff.health.declaredFit")}
              defaultChecked={detail?.kind === kind ? detail.declaredFit : false}
            />
            <Checkbox
              id={ids.adjustmentsAgreed}
              name="adjustmentsAgreed"
              label={t("staff.health.adjustments")}
              defaultChecked={detail?.kind === kind ? detail.adjustmentsAgreed : false}
            />
          </>
        );
      case "right_to_work":
        return (
          <>
            <p className="m-0 text-body-dense">{t("staff.rtw.addsCheck")}</p>
            <StaffDate
              id={ids.checkedOn}
              name="checkedOn"
              legend={t("staff.rtw.checkedOn")}
              result={result}
            />
            <SelectField
              id={ids.method}
              name="method"
              label={t("staff.rtw.method")}
              emptyOption={choose}
              options={RTW_METHODS.map((m) => ({
                value: m,
                label: t("staff.rtw.methodName", { method: m }),
              }))}
              error={err("method")}
            />
            <SelectField
              id={ids.permission}
              name="permission"
              label={t("staff.rtw.permission")}
              emptyOption={choose}
              options={(["unlimited", "time_limited"] as const).map((p) => ({
                value: p,
                label: t("staff.rtw.permissionName", { permission: p }),
              }))}
              error={err("permission")}
            />
            <StaffDate
              id={ids.expiresOn}
              name="expiresOn"
              legend={t("staff.rtw.expiresOn")}
              hint={t("staff.rtw.expiresHint")}
              result={result}
            />
          </>
        );
      case "professional_registration": {
        const reg = detail?.kind === kind ? detail : null;
        return (
          <>
            <SelectField
              id={ids.body}
              name="body"
              label={t("staff.form.registrationBody")}
              emptyOption={choose}
              defaultValue={reg?.body ?? ""}
              options={REGISTRATION_BODIES.map((b) => ({
                value: b,
                label: t("staff.registration.body", { body: b }),
              }))}
              error={err("body")}
            />
            <TextField
              id={ids.pin}
              name="pin"
              label={t("staff.registration.pin")}
              autoComplete="off"
              spellCheck={false}
              defaultValue={reg?.pin ?? ""}
              error={err("pin")}
            />
            <StaffDate
              id={ids.renewalDueOn}
              name="renewalDueOn"
              legend={t("staff.registration.renewal")}
              result={result}
              defaultValue={reg?.renewalDueOn}
            />
            <StaffDate
              id={ids.revalidationDueOn}
              name="revalidationDueOn"
              legend={t("staff.registration.revalidation")}
              result={result}
              defaultValue={reg?.revalidationDueOn}
            />
          </>
        );
      }
      default:
        return <p className="m-0">{t("staff.form.notRecordable")}</p>;
    }
  })();
  if (kind === "employment_history")
    return <p className="m-0 text-body-dense">{t("staff.form.notRecordable")}</p>;
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {fields}
      <Checkbox
        id={ids.verifiedToday}
        name="verifiedToday"
        label={t("staff.form.verifiedToday")}
        hint={t("staff.form.verifiedTodayHint")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("staff.form.recordItem", { kind })}
        </Button>
      </div>
      <StaffFeedback result={result} path={`${STAFF_PAGE}/${fileId}`} fieldIds={ids} />
    </form>
  );
}
