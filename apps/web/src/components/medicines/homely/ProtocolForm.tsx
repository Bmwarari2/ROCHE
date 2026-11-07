"use client";

import { Button, Checkbox, DateInput, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { ClipboardCheck } from "lucide-react";
import { addProtocol, changeProtocol } from "@/app/actions/homely-remedies";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import {
  type MemberOption,
  type ProtocolBody,
  type ProtocolChangeBody,
  protocolsHref,
  readProtocol,
  readProtocolChange,
} from "@/lib/homely-remedies";
import { characterCount, t } from "@/lib/i18n";
import { errorFor } from "@/lib/outcome";
import { useArrival, useMedicineSubmit } from "../MedicineForms";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const count = (remaining: number) => characterCount(remaining);
const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

const FIELDS = [
  "productName",
  "vmpId",
  "indication",
  "doseQuantity",
  "unitName",
  "minIntervalHours",
  "maxDailyQuantity",
  "maxDays",
  "authorisedMemberIds",
  "approvedByName",
  "approvedByRole",
  "approvedOn",
  "reviewOn",
  "reason",
] as const;

/**
 * Adding or changing a homely remedy protocol (slice 55; medicines.md section 15.3; HZ-120): the
 * product, what it is for, one dose, the shortest gap, the most in 24 hours, the days before the
 * GP is asked, the staff allowed to give it, and the GP or pharmacist who agreed it, when, and the
 * review. A change starts from the protocol as it stands and needs a new reason; doses already
 * given keep the version they were checked against. The API applies the rate table's limits and
 * answers in words at their fields.
 */
export function ProtocolForm({
  locationId,
  members,
  change,
  defaults = {},
  named = [],
}: {
  readonly locationId: string;
  readonly members: readonly MemberOption[];
  /** The protocol to change and the version read; omitted to add one. */
  readonly change?: { readonly protocolId: string; readonly version: number };
  readonly defaults?: Readonly<Record<string, string>>;
  /** The staff the protocol names now, ticked to start with. */
  readonly named?: readonly string[];
}) {
  const ids = useFieldIds(FIELDS);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit<ProtocolBody | ProtocolChangeBody, null>(
    (form) => (change ? readProtocolChange(form, t, change.version) : readProtocol(form, t)),
    (body) =>
      change && "reason" in body
        ? changeProtocol(locationId, change.protocolId, body)
        : addProtocol(locationId, body),
    () => arrive(protocolsHref(locationId), change ? "changed" : "added"),
  );
  const err = (field: string) => errorFor(result, field);
  const memberError = err("authorisedMemberIds");
  const memberOptionId = (i: number) =>
    i === 0 ? ids.authorisedMemberIds : `${ids.authorisedMemberIds}-${i}`;
  const memberHintId = `${ids.authorisedMemberIds}-group-hint`;
  const memberErrorId = `${ids.authorisedMemberIds}-group-error`;

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.productName}
        name="productName"
        label={t("medicines.homely.form.product")}
        hint={t("medicines.homely.form.productHint")}
        maxLength={200}
        defaultValue={defaults.productName ?? ""}
        error={err("productName")}
      />
      <TextField
        id={ids.vmpId}
        name="vmpId"
        label={t("medicines.homely.form.vmp")}
        hint={t("medicines.homely.form.vmpHint")}
        inputMode="numeric"
        defaultValue={defaults.vmpId ?? ""}
        error={err("vmpId")}
      />
      <TextArea
        id={ids.indication}
        name="indication"
        label={t("medicines.homely.form.indication")}
        hint={t("medicines.homely.form.indicationHint")}
        rows={2}
        maxLength={500}
        formatCount={count}
        defaultValue={defaults.indication ?? ""}
        error={err("indication")}
      />
      <TextField
        id={ids.doseQuantity}
        name="doseQuantity"
        label={t("medicines.homely.form.dose")}
        hint={t("medicines.homely.form.doseHint")}
        inputMode="decimal"
        defaultValue={defaults.doseQuantity ?? ""}
        error={err("doseQuantity")}
      />
      <TextField
        id={ids.unitName}
        name="unitName"
        label={t("medicines.homely.form.unit")}
        hint={t("medicines.homely.form.unitHint")}
        maxLength={60}
        defaultValue={defaults.unitName ?? ""}
        error={err("unitName")}
      />
      <TextField
        id={ids.minIntervalHours}
        name="minIntervalHours"
        label={t("medicines.homely.form.interval")}
        hint={t("medicines.homely.form.intervalHint")}
        inputMode="decimal"
        defaultValue={defaults.minIntervalHours ?? ""}
        error={err("minIntervalHours")}
      />
      <TextField
        id={ids.maxDailyQuantity}
        name="maxDailyQuantity"
        label={t("medicines.homely.form.daily")}
        hint={t("medicines.homely.form.dailyHint")}
        inputMode="decimal"
        defaultValue={defaults.maxDailyQuantity ?? ""}
        error={err("maxDailyQuantity")}
      />
      <TextField
        id={ids.maxDays}
        name="maxDays"
        label={t("medicines.homely.form.days")}
        hint={t("medicines.homely.form.daysHint")}
        inputMode="numeric"
        defaultValue={defaults.maxDays ?? ""}
        error={err("maxDays")}
      />
      <fieldset
        className="m-0 flex flex-col gap-1 border-0 p-0"
        aria-describedby={memberError ? `${memberHintId} ${memberErrorId}` : memberHintId}
      >
        <legend className="mb-1 p-0 font-semibold">{t("medicines.homely.form.staff")}</legend>
        <p id={memberHintId} className="hb-field__hint m-0">
          {t("medicines.homely.form.staffHint")}
        </p>
        {memberError ? (
          <p id={memberErrorId} className="hb-field__error m-0">
            {memberError}
          </p>
        ) : null}
        {members.map((member, i) => (
          <Checkbox
            key={member.id}
            id={memberOptionId(i)}
            name="authorisedMemberIds"
            value={member.id}
            label={member.label}
            defaultChecked={named.includes(member.id)}
            aria-invalid={memberError ? true : undefined}
            aria-describedby={memberError ? memberErrorId : undefined}
          />
        ))}
      </fieldset>
      <TextField
        id={ids.approvedByName}
        name="approvedByName"
        label={t("medicines.homely.form.approvedBy")}
        maxLength={200}
        defaultValue={defaults.approvedByName ?? ""}
        error={err("approvedByName")}
      />
      <RadioGroup
        id={ids.approvedByRole}
        name="approvedByRole"
        legend={t("medicines.homely.form.role")}
        options={(["gp", "pharmacist"] as const).map((role) => ({
          value: role,
          label: t("medicines.homely.role", { role }),
        }))}
        {...(defaults.approvedByRole === "gp" || defaults.approvedByRole === "pharmacist"
          ? { defaultValue: defaults.approvedByRole }
          : {})}
        error={err("approvedByRole")}
      />
      <DateInput
        id={ids.approvedOn}
        name="approvedOn"
        legend={t("medicines.homely.form.approvedOn")}
        labels={dateLabels}
        defaultValue={defaults.approvedOn ?? null}
        error={err("approvedOn")}
      />
      <DateInput
        id={ids.reviewOn}
        name="reviewOn"
        legend={t("medicines.homely.form.reviewOn")}
        hint={t("medicines.homely.form.reviewOnHint")}
        labels={dateLabels}
        defaultValue={defaults.reviewOn ?? null}
        error={err("reviewOn")}
      />
      {change ? (
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("medicines.homely.form.changeReason")}
          hint={t("medicines.homely.form.changeReasonHint")}
          rows={2}
          maxLength={500}
          formatCount={count}
          error={err("reason")}
        />
      ) : null}
      <div>
        <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
          {pending
            ? t("common.saving")
            : change
              ? t("medicines.homely.form.changeSubmit")
              : t("medicines.homely.form.addSubmit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={change ? t("medicines.homely.changed") : t("medicines.homely.added")}
        fieldIds={ids}
      />
    </form>
  );
}
