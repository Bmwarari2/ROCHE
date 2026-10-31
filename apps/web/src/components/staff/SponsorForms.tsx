"use client";

import { Button, Checkbox, RadioGroup, SelectField, TextField } from "@harbour/ui";
import { Save } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createSponsoredWorker,
  markReported,
  recordAbsence,
  recordReport,
  updateSponsoredWorker,
} from "@/app/actions/staff";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { errorFor } from "@/lib/outcome";
import {
  APPENDIX_D,
  ENGLISH_EVIDENCE,
  REPORT_KINDS,
  readAbsence,
  readMarkReported,
  readReport,
  readSponsoredWorker,
  SPONSOR_PAGE,
  SPONSOR_ROUTES,
  type SponsoredWorker,
  type StaffName,
} from "@/lib/staff";
import { StaffDate, StaffFeedback } from "./StaffForms";
import { useStaffForm } from "./use-staff-form";

const icon = <Save size={18} strokeWidth={1.5} aria-hidden="true" />;

const WORKER_FIELDS = [
  "tenantUserId",
  "cosReference",
  "cosAssignedOn",
  "socCode",
  "route",
  "visaExpiresOn",
  "contractedWeeklyHours",
  "guaranteedYearlyPay",
  "englishEvidence",
  "switchingEvidenceOn",
  "endedOn",
  "appendixD",
] as const;

/**
 * A sponsored worker's record (HR only): the certificate, visa, hours and pay, English language
 * and switching evidence, and the Appendix D records held. Never one's own: the member list leaves
 * the reader out, and the API refuses it anyway.
 */
export function SponsoredWorkerForm({
  members,
  worker,
}: {
  readonly members?: readonly StaffName[];
  readonly worker?: SponsoredWorker;
}) {
  const router = useRouter();
  const ids = useFieldIds(WORKER_FIELDS);
  const creating = !worker;
  const { result, pending, submit } = useStaffForm(
    (form) => readSponsoredWorker(form, t, creating),
    (value) =>
      worker
        ? updateSponsoredWorker(worker.id, worker.version, value)
        : createSponsoredWorker({ ...value, tenantUserId: value.tenantUserId ?? "" }),
    (data) => {
      if (creating && data && typeof data === "object" && "id" in data) {
        router.push(`${SPONSOR_PAGE}/${String(data.id)}`);
      }
    },
  );
  const choose = t("staff.form.choose");
  const err = (field: string) => errorFor(result, field);
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {creating ? (
        <SelectField
          id={ids.tenantUserId}
          name="tenantUserId"
          label={t("staff.form.member")}
          hint={t("sponsor.form.memberHint")}
          emptyOption={choose}
          options={(members ?? []).map((m) => ({ value: m.id, label: m.displayName }))}
          error={err("tenantUserId")}
        />
      ) : null}
      <TextField
        id={ids.cosReference}
        name="cosReference"
        label={t("sponsor.form.cosReference")}
        hint={t("sponsor.form.cosHint")}
        autoComplete="off"
        spellCheck={false}
        maxLength={20}
        defaultValue={worker?.cosReference ?? ""}
        error={err("cosReference")}
      />
      <StaffDate
        id={ids.cosAssignedOn}
        name="cosAssignedOn"
        legend={t("sponsor.form.cosAssignedOn")}
        result={result}
        defaultValue={worker?.cosAssignedOn}
      />
      <TextField
        id={ids.socCode}
        name="socCode"
        label={t("sponsor.form.socCode")}
        hint={t("sponsor.form.socHint")}
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        defaultValue={worker?.socCode ?? ""}
        error={err("socCode")}
      />
      <SelectField
        id={ids.route}
        name="route"
        label={t("sponsor.form.route")}
        emptyOption={choose}
        defaultValue={worker?.route ?? ""}
        options={SPONSOR_ROUTES.map((r) => ({
          value: r,
          label: t("sponsor.route.name", { route: r }),
        }))}
        error={err("route")}
      />
      <StaffDate
        id={ids.visaExpiresOn}
        name="visaExpiresOn"
        legend={t("sponsor.form.visaExpiresOn")}
        result={result}
        defaultValue={worker?.visaExpiresOn}
      />
      <TextField
        id={ids.contractedWeeklyHours}
        name="contractedWeeklyHours"
        label={t("sponsor.form.hours")}
        hint={t("sponsor.form.hoursHint")}
        inputMode="decimal"
        autoComplete="off"
        maxLength={6}
        defaultValue={worker ? String(worker.contractedWeeklyHours) : ""}
        error={err("contractedWeeklyHours")}
      />
      <TextField
        id={ids.guaranteedYearlyPay}
        name="guaranteedYearlyPay"
        label={t("sponsor.form.pay")}
        hint={t("sponsor.form.payHint")}
        inputMode="decimal"
        autoComplete="off"
        maxLength={12}
        defaultValue={worker ? String(worker.guaranteedYearlyPay) : ""}
        error={err("guaranteedYearlyPay")}
      />
      <SelectField
        id={ids.englishEvidence}
        name="englishEvidence"
        label={t("sponsor.form.english")}
        defaultValue={worker?.englishEvidence ?? "not_recorded"}
        options={ENGLISH_EVIDENCE.map((e) => ({
          value: e,
          label: t("sponsor.english.name", { evidence: e }),
        }))}
        error={err("englishEvidence")}
      />
      <StaffDate
        id={ids.switchingEvidenceOn}
        name="switchingEvidenceOn"
        legend={t("sponsor.form.switching")}
        hint={t("sponsor.form.switchingHint")}
        result={result}
        defaultValue={worker?.switchingEvidenceOn}
      />
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" id={ids.appendixD}>
        <legend className="mb-2 text-body font-semibold">{t("sponsor.form.appendixD")}</legend>
        {APPENDIX_D.map((item) => (
          <Checkbox
            key={item}
            name={`appendixD.${item}`}
            label={t("sponsor.appendixD.name", { item })}
            defaultChecked={worker?.appendixDHeld.includes(item) ?? false}
          />
        ))}
      </fieldset>
      {creating ? null : (
        <StaffDate
          id={ids.endedOn}
          name="endedOn"
          legend={t("sponsor.form.endedOn")}
          hint={t("sponsor.form.endedHint")}
          result={result}
          defaultValue={worker?.endedOn}
        />
      )}
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending
            ? t("common.saving")
            : creating
              ? t("sponsor.form.create")
              : t("sponsor.form.save")}
        </Button>
      </div>
      <StaffFeedback
        result={result}
        path={worker ? `${SPONSOR_PAGE}/${worker.id}` : SPONSOR_PAGE}
        fieldIds={ids}
        success={t("sponsor.form.saved")}
      />
    </form>
  );
}

const ABSENCE_FIELDS = ["fromOn", "toOn", "authorised"] as const;

/** An absence, authorised or not; the record then says whether a report is needed. */
export function AbsenceForm({ workerId }: { readonly workerId: string }) {
  const ids = useFieldIds(ABSENCE_FIELDS);
  const { result, pending, submit } = useStaffForm(
    (form) => readAbsence(form, t),
    (value) => recordAbsence(workerId, value),
    (_data, form) => form.reset(),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <StaffDate id={ids.fromOn} name="fromOn" legend={t("sponsor.absence.from")} result={result} />
      <StaffDate id={ids.toOn} name="toOn" legend={t("sponsor.absence.to")} result={result} />
      <RadioGroup
        id={ids.authorised}
        name="authorised"
        legend={t("sponsor.absence.authorised")}
        options={[
          { value: "yes", label: t("sponsor.absence.yes") },
          { value: "no", label: t("sponsor.absence.no") },
        ]}
        error={errorFor(result, "authorised")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("sponsor.absence.submit")}
        </Button>
      </div>
      <StaffFeedback
        result={result}
        path={`${SPONSOR_PAGE}/${workerId}`}
        fieldIds={ids}
        success={t("sponsor.absence.saved")}
      />
    </form>
  );
}

const REPORT_FIELDS = ["kind", "happenedOn"] as const;

/** A change to report on the sponsor management system, with the day it happened. */
export function ReportForm({
  workerId,
  suggested,
}: {
  readonly workerId: string;
  readonly suggested?: { readonly happenedOn: string } | null;
}) {
  const ids = useFieldIds(REPORT_FIELDS);
  const { result, pending, submit } = useStaffForm(
    (form) => readReport(form, t),
    (value) => recordReport(workerId, value),
    (_data, form) => form.reset(),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.kind}
        name="kind"
        label={t("sponsor.report.kind")}
        emptyOption={t("staff.form.choose")}
        defaultValue={suggested ? "unauthorised_absence" : ""}
        options={REPORT_KINDS.map((k) => ({
          value: k,
          label: t("sponsor.report.kindName", { kind: k }),
        }))}
        error={errorFor(result, "kind")}
      />
      <StaffDate
        id={ids.happenedOn}
        name="happenedOn"
        legend={t("sponsor.report.happenedOn")}
        result={result}
        defaultValue={suggested?.happenedOn}
      />
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("sponsor.report.submit")}
        </Button>
      </div>
      <StaffFeedback
        result={result}
        path={`${SPONSOR_PAGE}/${workerId}`}
        fieldIds={ids}
        success={t("sponsor.report.saved")}
      />
    </form>
  );
}

const REPORTED_FIELDS = ["reportedOn", "smsReference"] as const;

/** The date a change was reported and the reference the sponsor management system gave. */
export function MarkReportedForm({
  workerId,
  report,
}: {
  readonly workerId: string;
  readonly report: SponsoredWorker["reports"][number];
}) {
  const ids = useFieldIds(REPORTED_FIELDS);
  const { result, pending, submit } = useStaffForm(
    (form) => readMarkReported(form, report.happenedOn, t),
    (value) => markReported(report.id, report.version, value),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <StaffDate
        id={ids.reportedOn}
        name="reportedOn"
        legend={t("sponsor.report.reportedOn")}
        result={result}
      />
      <TextField
        id={ids.smsReference}
        name="smsReference"
        label={t("sponsor.report.reference")}
        autoComplete="off"
        spellCheck={false}
        maxLength={40}
        error={errorFor(result, "smsReference")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("sponsor.report.markSubmit")}
        </Button>
      </div>
      <StaffFeedback
        result={result}
        path={`${SPONSOR_PAGE}/${workerId}`}
        fieldIds={ids}
        success={t("sponsor.report.marked")}
      />
    </form>
  );
}
