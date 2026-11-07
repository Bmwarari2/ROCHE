"use client";

import { Button, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { PackageMinus, PackagePlus, Plus, Scale, Trash2, UserCheck } from "lucide-react";
import { useState } from "react";
import {
  countStock,
  disposeStock,
  moveStock,
  openStockItem,
  witnessDisposal,
} from "@/app/actions/medicine-stock";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { useArrival, useMedicineSubmit } from "@/components/medicines/MedicineForms";
import { characterCount, t } from "@/lib/i18n";
import {
  DISPOSAL_REASONS,
  personStockHref,
  readDisposal,
  readOpenItem,
  readStockCount,
  readStockQuantityForm,
  stockItemHref,
} from "@/lib/medicine-stock";
import { errorFor } from "@/lib/outcome";

/**
 * A person's stock forms (slice 55; MEDS-008; medicines.md section 15 rules 1, 2, 4 and 5):
 * opening an item from the MAR, a receipt, a return, a count and a disposal, and confirming a
 * disposal as its witness. Each is read here first so a mistake is said at its field; the API
 * decides again (the witness, the balance under a lock) and its words are shown as they are. A
 * controlled drug is never counted here: its register keeps its stock.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const count = (remaining: number) => characterCount(remaining);

/** Opens a stock item from one of the person's MAR entries without one. */
export function OpenItemForm({
  personId,
  entries,
}: {
  readonly personId: string;
  readonly entries: readonly { readonly id: string; readonly name: string }[];
}) {
  const ids = useFieldIds(["medicationId"]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readOpenItem(form, t),
    (body) => openStockItem(personId, body),
    () => arrive(personStockHref(personId), "opened"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.medicationId}
        name="medicationId"
        label={t("medicines.stock.open.medicine")}
        hint={t("medicines.stock.open.hint")}
        emptyOption={t("medicines.form.choose")}
        options={entries.map((e) => ({ value: e.id, label: e.name }))}
        error={errorFor(result, "medicationId")}
      />
      <div>
        <Button type="submit" icon={<Plus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.open.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.open.done")} fieldIds={ids} />
    </form>
  );
}

/** Medicines received, naming the order line they fill when there is one. */
export function ReceiptForm({
  personId,
  itemId,
  unitName,
  lines,
}: {
  readonly personId: string;
  readonly itemId: string;
  readonly unitName: string;
  /** Open order lines for this medicine, already in words. */
  readonly lines: readonly { readonly id: string; readonly label: string }[];
}) {
  const ids = useFieldIds(["quantity", "orderLineId"]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readStockQuantityForm(form, t, "receipt"),
    (body) => moveStock(personId, itemId, "receipt", body),
    () => arrive(stockItemHref(personId, itemId), "received"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.quantity}
        name="quantity"
        label={t("medicines.stock.quantity", { unit: unitName })}
        hint={t("medicines.stock.quantityHint")}
        inputMode="decimal"
        error={errorFor(result, "quantity")}
      />
      {lines.length > 0 ? (
        <SelectField
          id={ids.orderLineId}
          name="orderLineId"
          label={t("medicines.stock.receipt.line")}
          hint={t("medicines.stock.receipt.lineHint")}
          emptyOption={t("medicines.stock.receipt.noLine")}
          options={lines.map((l) => ({ value: l.id, label: l.label }))}
          error={errorFor(result, "orderLineId")}
        />
      ) : null}
      <div>
        <Button type="submit" icon={<PackagePlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.receipt.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.receipt.done")} fieldIds={ids} />
    </form>
  );
}

/** Medicines returned to the pharmacy. */
export function ReturnForm({
  personId,
  itemId,
  unitName,
}: {
  readonly personId: string;
  readonly itemId: string;
  readonly unitName: string;
}) {
  const ids = useFieldIds(["quantity"]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readStockQuantityForm(form, t, "return"),
    (body) => moveStock(personId, itemId, "return", body),
    () => arrive(stockItemHref(personId, itemId), "returned"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.quantity}
        name="quantity"
        label={t("medicines.stock.quantity", { unit: unitName })}
        hint={t("medicines.stock.quantityHint")}
        inputMode="decimal"
        error={errorFor(result, "quantity")}
      />
      <div>
        <Button type="submit" icon={<PackageMinus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.return.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.return.done")} fieldIds={ids} />
    </form>
  );
}

/** A count; one that differs from the balance shown needs a reason, and adjusts the balance. */
export function CountForm({
  personId,
  itemId,
  unitName,
  balance,
}: {
  readonly personId: string;
  readonly itemId: string;
  readonly unitName: string;
  readonly balance: number;
}) {
  const ids = useFieldIds(["counted", "reason"]);
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readStockCount(form, t, balance),
    (body) => countStock(personId, itemId, body),
    () => arrive(stockItemHref(personId, itemId), "counted"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.counted}
        name="counted"
        label={t("medicines.stock.count.counted", { unit: unitName })}
        hint={t("medicines.stock.count.countedHint")}
        inputMode="decimal"
        error={errorFor(result, "counted")}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("medicines.stock.count.reason")}
        hint={t("medicines.stock.count.reasonHint")}
        rows={2}
        maxLength={500}
        formatCount={count}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button type="submit" icon={<Scale {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.count.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.count.done")} fieldIds={ids} />
    </form>
  );
}

/**
 * A disposal: the quantity, the reason, a note, and its witness, a second member who confirms it
 * themselves (a task asks them), or why no one could witness it where the organisation's policy
 * allows. The stock leaves when it is recorded.
 */
export function DisposalForm({
  personId,
  itemId,
  unitName,
  me,
  witnesses,
}: {
  readonly personId: string;
  readonly itemId: string;
  readonly unitName: string;
  readonly me: string;
  /** Staff at the home who may be named, or null when the list cannot be read. */
  readonly witnesses: readonly { readonly id: string; readonly name: string }[] | null;
}) {
  const ids = useFieldIds([
    "quantity",
    "reason",
    "note",
    "witnessed",
    "witnessId",
    "noWitnessReason",
  ]);
  const arrive = useArrival();
  const [witnessed, setWitnessed] = useState("");
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readDisposal(form, t, me),
    (body) => disposeStock(personId, itemId, body),
    (data) =>
      arrive(
        stockItemHref(personId, itemId),
        data?.disposal?.status === "awaiting_witness" ? "disposed_awaiting" : "disposed",
      ),
  );
  const choices = (witnesses ?? []).filter((w) => w.id !== me);
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.quantity}
        name="quantity"
        label={t("medicines.stock.quantity", { unit: unitName })}
        hint={t("medicines.stock.quantityHint")}
        inputMode="decimal"
        error={errorFor(result, "quantity")}
      />
      <SelectField
        id={ids.reason}
        name="reason"
        label={t("medicines.stock.disposal.reason")}
        emptyOption={t("medicines.form.choose")}
        options={DISPOSAL_REASONS.map((reason) => ({
          value: reason,
          label: t("medicines.stock.disposal.reasonOption", { reason }),
        }))}
        error={errorFor(result, "reason")}
      />
      <TextArea
        id={ids.note}
        name="note"
        label={t("medicines.stock.disposal.note")}
        hint={t("medicines.form.optional")}
        rows={2}
        maxLength={500}
        formatCount={count}
        error={errorFor(result, "note")}
      />
      <RadioGroup
        id={ids.witnessed}
        name="witnessed"
        legend={t("medicines.stock.disposal.witnessed")}
        hint={t("medicines.stock.disposal.witnessedHint")}
        options={(["witness", "no_witness"] as const).map((w) => ({
          value: w,
          label: t("medicines.stock.disposal.witnessedOption", { witnessed: w }),
        }))}
        onValueChange={setWitnessed}
        error={errorFor(result, "witnessed")}
      />
      {witnessed === "witness" && witnesses !== null ? (
        <SelectField
          id={ids.witnessId}
          name="witnessId"
          label={t("medicines.stock.disposal.witness")}
          hint={t("medicines.stock.disposal.witnessHint")}
          emptyOption={t("medicines.form.choose")}
          options={choices.map((w) => ({ value: w.id, label: w.name }))}
          error={errorFor(result, "witnessId")}
        />
      ) : null}
      {witnessed === "witness" && witnesses === null ? (
        <p className="m-0 max-w-prose" id={ids.witnessId} tabIndex={-1}>
          {errorFor(result, "witnessId") ?? t("medicines.stock.disposal.noWitnessList")}
        </p>
      ) : null}
      {witnessed === "no_witness" ? (
        <TextArea
          id={ids.noWitnessReason}
          name="noWitnessReason"
          label={t("medicines.stock.disposal.noWitnessReason")}
          hint={t("medicines.stock.disposal.noWitnessReasonHint")}
          rows={2}
          maxLength={500}
          formatCount={count}
          error={errorFor(result, "noWitnessReason")}
        />
      ) : null}
      <p className="m-0 max-w-prose">{t("medicines.stock.disposal.consequence")}</p>
      <div>
        <Button type="submit" variant="destructive" icon={<Trash2 {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.disposal.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.disposal.done")} fieldIds={ids} />
    </form>
  );
}

/** The named witness confirms the disposal they saw, from their own session, once. */
export function WitnessDisposalForm({
  personId,
  disposalId,
}: {
  readonly personId: string;
  readonly disposalId: string;
}) {
  const arrive = useArrival();
  const { result, pending, submit } = useMedicineSubmit(
    () => ({ ok: true as const, body: null }),
    () => witnessDisposal(personId, disposalId),
    () => arrive(personStockHref(personId), "witnessed"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div>
        <Button type="submit" icon={<UserCheck {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.stock.witness.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.stock.witness.done")} />
    </form>
  );
}
