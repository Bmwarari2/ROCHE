"use client";

import { Button, Checkbox, SelectField, TextArea, TextField } from "@harbour/ui";
import { CircleCheck, ClipboardCheck, Search, TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState, useTransition } from "react";
import { checkHomelyDose, recordHomelyDose } from "@/app/actions/homely-remedies";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import {
  checkKey,
  checkSays,
  type HomelyDoseCheck,
  type HomelyProtocol,
  personHomelyHref,
  readDose,
  readDoseCheck,
} from "@/lib/homely-remedies";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { useArrival } from "../MedicineForms";
import { ProtocolSummary } from "./ProtocolSummary";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const FIELDS = [
  "protocolId",
  "quantity",
  "reason",
  "allergiesChecked",
  "medicinesChecked",
] as const;

/**
 * Giving a homely remedy (slice 55; medicines.md section 15.3; HZ-120, HZ-007). The person and
 * every allergy are shown at the top (`person`). The giver chooses the home's protocol, whose
 * figures are shown beside it, and the amount (offered as the protocol's dose), then checks it with
 * the API before anything is recorded: the API says in its own words whether it is within the
 * protocol now (who may give it, the dose, the shortest gap, the most in 24 hours, the protocol's
 * days for the course, the same product prescribed). Only a dose the check found within the
 * protocol, for the same protocol and amount, can then be recorded, with why it is given and the
 * giver's confirmation that they compared the allergies. The API checks everything again.
 */
export function HomelyDoseForm({
  personId,
  protocols,
  recordId,
  person,
  currentMedicines,
}: {
  readonly personId: string;
  /** The home's protocols in use. */
  readonly protocols: readonly HomelyProtocol[];
  /** The client's UUID for this record, made by the page, so a resend is the same record. */
  readonly recordId: string;
  readonly person: ReactNode;
  /** The person's current medicines on the eMAR, to compare with the remedy (HZ-120). */
  readonly currentMedicines: ReactNode;
}) {
  const ids = useFieldIds(FIELDS);
  const arrive = useArrival();
  const formRef = useRef<HTMLFormElement>(null);
  const [protocolId, setProtocolId] = useState<string>(
    protocols.length === 1 ? (protocols[0]?.id ?? "") : "",
  );
  const chosen = protocols.find((p) => p.id === protocolId) ?? null;
  const [quantity, setQuantity] = useState<string>(chosen ? String(chosen.doseQuantity) : "");
  const [checked, setChecked] = useState<{
    readonly key: string;
    readonly check: HomelyDoseCheck;
  } | null>(null);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const current = checked && checked.key === checkKey(protocolId, quantity) ? checked : null;
  const says = current ? checkSays(current.check) : null;

  const check = () => {
    if (!formRef.current || pending) return;
    const read = readDoseCheck(new FormData(formRef.current), t);
    if (!read.ok) {
      setResult(fieldErrors(read.errors));
      return;
    }
    const key = checkKey(protocolId, quantity);
    startTransition(async () => {
      const outcome = await checkHomelyDose(personId, read.body);
      if (outcome.ok) {
        setChecked({ key, check: outcome.data });
        setResult(null);
      } else {
        setResult(outcome);
      }
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!says?.within) {
      check();
      return;
    }
    const read = readDose(new FormData(event.currentTarget), t, { id: recordId });
    if (!read.ok) {
      setResult(fieldErrors(read.errors));
      return;
    }
    startTransition(async () => {
      const outcome = await recordHomelyDose(personId, read.body);
      setResult(outcome);
      if (outcome.ok) arrive(personHomelyHref(personId), "recorded");
    });
  };

  return (
    <form ref={formRef} method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {person}
      {currentMedicines}
      <SelectField
        id={ids.protocolId}
        name="protocolId"
        label={t("medicines.homely.dose.protocol")}
        hint={t("medicines.homely.dose.protocolHint")}
        value={protocolId}
        emptyOption={t("medicines.form.choose")}
        options={protocols.map((p) => ({
          value: p.id,
          label: t("medicines.homely.dose.protocolOption", {
            product: p.productName,
            indication: p.indication,
          }),
        }))}
        onChange={(e) => {
          const next = protocols.find((p) => p.id === e.target.value) ?? null;
          setProtocolId(e.target.value);
          setQuantity(next ? String(next.doseQuantity) : "");
        }}
        error={errorFor(result, "protocolId")}
      />
      {chosen ? (
        <section
          aria-label={t("medicines.homely.dose.protocolLabel")}
          className="flex flex-col gap-2 rounded-input border border-border p-3"
        >
          <p className="m-0 font-semibold">{chosen.productName}</p>
          <ProtocolSummary protocol={chosen} />
        </section>
      ) : null}
      <TextField
        id={ids.quantity}
        name="quantity"
        label={
          chosen
            ? t("medicines.homely.dose.quantity", { unit: chosen.unitName })
            : t("medicines.homely.dose.quantityNoUnit")
        }
        hint={t("medicines.homely.dose.quantityHint")}
        inputMode="decimal"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        error={errorFor(result, "quantity")}
      />
      <div>
        <Button
          type="button"
          variant="secondary"
          icon={<Search {...icon} />}
          disabled={pending}
          onClick={check}
        >
          {pending && !says?.within
            ? t("medicines.homely.dose.checking")
            : t("medicines.homely.dose.check")}
        </Button>
      </div>
      {chosen && !chosen.vmpId ? (
        <p className="m-0 inline-flex items-start gap-2 font-semibold">
          <TriangleAlert {...icon} />
          {t("medicines.homely.dose.noDmd")}
        </p>
      ) : null}
      <section
        aria-label={t("medicines.homely.dose.checkLabel")}
        aria-live="polite"
        className="flex flex-col gap-2"
      >
        {says?.within ? (
          <p className="m-0 inline-flex items-center gap-2 font-semibold">
            <CircleCheck {...icon} />
            {t("medicines.homely.dose.within")}
          </p>
        ) : null}
        {says && !says.within ? (
          <div className="flex flex-col gap-1 rounded-input border-s-4 border-warning bg-bg-secondary p-3">
            <p className="m-0 inline-flex items-center gap-2 font-semibold">
              <TriangleAlert {...icon} />
              {t("medicines.homely.dose.outside")}
            </p>
            <ul className="m-0 flex flex-col gap-1 pl-5">
              {says.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            <p className="m-0">{t("medicines.homely.dose.outsideNext")}</p>
          </div>
        ) : null}
        {checked && !current ? (
          <p className="m-0">{t("medicines.homely.dose.checkAgain")}</p>
        ) : null}
      </section>
      {says?.within ? (
        <>
          <TextArea
            id={ids.reason}
            name="reason"
            label={t("medicines.homely.dose.reason")}
            hint={t("medicines.homely.dose.reasonHint")}
            rows={2}
            maxLength={500}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, "reason")}
          />
          <Checkbox
            id={ids.medicinesChecked}
            name="medicinesChecked"
            value="yes"
            label={t("medicines.homely.dose.medicines")}
            hint={t("medicines.homely.dose.medicinesHint")}
            error={errorFor(result, "medicinesChecked")}
          />
          <Checkbox
            id={ids.allergiesChecked}
            name="allergiesChecked"
            value="yes"
            label={t("medicines.homely.dose.allergies")}
            hint={t("medicines.homely.dose.allergiesHint")}
            error={errorFor(result, "allergiesChecked")}
          />
          <div>
            <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
              {pending ? t("common.saving") : t("medicines.homely.dose.submit")}
            </Button>
          </div>
        </>
      ) : null}
      <FormFeedback result={result} success={t("medicines.homely.dose.done")} fieldIds={ids} />
    </form>
  );
}
