"use client";

import {
  Button,
  Checkbox,
  DateTimeInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { ClipboardCheck, FilePlus2, ListPlus, Play, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  addReconciliationItem,
  addReconciliationSource,
  completeReconciliation,
  decideReconciliation,
  startReconciliation,
} from "@/app/actions/medicines";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import {
  LINE_SAYS,
  type ProductHit,
  RECONCILIATION_SOURCE_KINDS,
  readCompletion,
  readEntryDecision,
  readItemDecision,
  readReconciliationItem,
  readReconciliationSource,
  reconciliationHref,
} from "@/lib/medicines";
import { errorFor } from "@/lib/outcome";
import { dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";
import { DRAFT_FIELDS, DraftFields, ProductPicker, useMedicineSubmit } from "./MedicineForms";

/**
 * Reconciliation forms (medicines.md section 13 rule 6): sources, then lines, then a decision by a
 * person for every entry and line, then completion. Harbour never decides and never infers a stop:
 * a line that says "stop" stops nothing until a person decides it.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Starts a reconciliation for an outstanding event, or for a change. */
export function StartReconciliationForm({
  personId,
  trigger,
  eventId,
  label,
}: {
  readonly personId: string;
  readonly trigger: "admission" | "transfer" | "return_from_hospital" | "change";
  readonly eventId: string | null;
  readonly label: string;
}) {
  const router = useRouter();
  const { result, pending, submit } = useMedicineSubmit(
    () => ({
      ok: true as const,
      body: {
        trigger,
        eventId,
        triggeredAt: eventId ? null : new Date().toISOString(),
      },
    }),
    (body) => startReconciliation(personId, body),
    (rec) => {
      if (rec) router.push(reconciliationHref(personId, rec.id));
    },
  );
  return (
    <form method="post" className="flex flex-col gap-2" onSubmit={submit} noValidate>
      <div>
        <Button type="submit" variant="secondary" icon={<Play {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : label}
        </Button>
      </div>
      <FormFeedback result={result} success="" />
    </form>
  );
}

/** A source the reconciliation compares against. */
export function AddSourceForm({
  personId,
  recId,
}: {
  readonly personId: string;
  readonly recId: string;
}) {
  const ids = useFieldIds(["sourceKind", "sourceReference", "receivedAt", "currentBecause"]);
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readReconciliationSource(form, t),
    (body) => addReconciliationSource(personId, recId, body),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.sourceKind}
        name="sourceKind"
        label={t("medicines.form.sourceKind")}
        defaultValue=""
        emptyOption={t("medicines.form.choose")}
        options={RECONCILIATION_SOURCE_KINDS.map((k) => ({
          value: k,
          label: t("medicines.sourceKind", { kind: k }),
        }))}
        error={errorFor(result, "sourceKind")}
      />
      <TextField
        id={ids.sourceReference}
        name="sourceReference"
        label={t("medicines.form.sourceReference")}
        hint={t("medicines.form.sourceReferenceHint")}
        autoComplete="off"
        error={errorFor(result, "sourceReference")}
      />
      <DateTimeInput
        id={ids.receivedAt}
        name="receivedAt"
        legend={t("medicines.rec.receivedAt")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "receivedAt")}
      />
      <TextArea
        id={ids.currentBecause}
        name="currentBecause"
        label={t("medicines.rec.currentBecause")}
        hint={t("medicines.rec.currentBecauseHint")}
        rows={2}
        maxLength={2000}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<FilePlus2 {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.rec.addSource")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.rec.sourceAdded")} fieldIds={ids} />
    </form>
  );
}

/** A line copied from a source, as written, with what it says. */
export function AddItemForm({
  personId,
  recId,
  sources,
  allergies,
}: {
  readonly personId: string;
  readonly recId: string;
  readonly sources: readonly { readonly id: string; readonly label: string }[];
  readonly allergies: ReactNode;
}) {
  const ids = useFieldIds(["sourceId", "asWritten", "says"]);
  const [product, setProduct] = useState<ProductHit | null>(null);
  const offered = new Set(sources.map((s) => s.id));
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readReconciliationItem(form, t, offered, product),
    (body) => addReconciliationItem(personId, recId, body),
    () => setProduct(null),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.sourceId}
        name="sourceId"
        label={t("medicines.rec.lineSource")}
        defaultValue=""
        emptyOption={t("medicines.form.choose")}
        options={sources.map((s) => ({ value: s.id, label: s.label }))}
        error={errorFor(result, "sourceId")}
      />
      <TextArea
        id={ids.asWritten}
        name="asWritten"
        label={t("medicines.rec.asWritten")}
        hint={t("medicines.rec.asWrittenHint")}
        rows={2}
        maxLength={2000}
        error={errorFor(result, "asWritten")}
      />
      <RadioGroup
        id={ids.says}
        name="says"
        legend={t("medicines.rec.says")}
        hint={t("medicines.rec.saysHint")}
        options={LINE_SAYS.map((s) => ({
          value: s,
          label: t("medicines.rec.saysOption", { says: s }),
        }))}
        error={errorFor(result, "says")}
      />
      <ProductPicker chosen={product} onChoose={setProduct} allergies={allergies} />
      <div>
        <Button type="submit" variant="secondary" icon={<ListPlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.rec.addLine")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.rec.lineAdded")} fieldIds={ids} />
    </form>
  );
}

/** Which lines support a decision (tick boxes), when there are lines. */
function LinesSupporting({
  lines,
}: {
  readonly lines: readonly { readonly id: string; readonly label: string }[];
}) {
  if (lines.length === 0) return null;
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-2 font-semibold">{t("medicines.rec.supportingLines")}</legend>
      {lines.map((line) => (
        <Checkbox key={line.id} name="itemIds" value={line.id} label={line.label} />
      ))}
    </fieldset>
  );
}

/** A person's decision about one current entry. */
export function EntryDecisionForm({
  personId,
  recId,
  entryId,
  lines,
  allergies,
}: {
  readonly personId: string;
  readonly recId: string;
  readonly entryId: string;
  readonly lines: readonly { readonly id: string; readonly label: string }[];
  readonly allergies: ReactNode;
}) {
  const ids = useFieldIds([
    ...DRAFT_FIELDS,
    "decision",
    "reason",
    "question",
    "note",
    "confirmedWith",
  ]);
  const [kind, setKind] = useState("");
  const [product, setProduct] = useState<ProductHit | null>(null);
  const offered = new Set(lines.map((l) => l.id));
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readEntryDecision(form, t, entryId, offered, product),
    (decision) => decideReconciliation(personId, recId, { on: "entry", decision }),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.decision}
        name="decision"
        legend={t("medicines.rec.decide")}
        options={["continue", "change", "stop", "query"].map((k) => ({
          value: k,
          label: t("medicines.rec.entryDecision", { kind: k }),
        }))}
        onValueChange={setKind}
        error={errorFor(result, "decision")}
      />
      {kind === "continue" ? (
        <>
          <TextArea
            id={ids.note}
            name="note"
            label={t("medicines.rec.note")}
            rows={2}
            maxLength={2000}
          />
          <TextField
            id={ids.confirmedWith}
            name="confirmedWith"
            label={t("medicines.rec.confirmedWith")}
            hint={t("medicines.rec.confirmedWithHint")}
            autoComplete="off"
          />
        </>
      ) : null}
      {kind === "change" ? (
        <DraftFields
          product={product}
          onProduct={setProduct}
          result={result}
          ids={ids}
          allergies={allergies}
        />
      ) : null}
      {kind === "stop" ? (
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("medicines.stop.reason")}
          rows={2}
          maxLength={2000}
          error={errorFor(result, "reason")}
        />
      ) : null}
      {kind === "query" ? (
        <TextArea
          id={ids.question}
          name="question"
          label={t("medicines.rec.question")}
          hint={t("medicines.rec.questionHint")}
          rows={2}
          maxLength={2000}
          error={errorFor(result, "question")}
        />
      ) : null}
      {kind && kind !== "query" ? <LinesSupporting lines={lines} /> : null}
      <div>
        <Button type="submit" variant="secondary" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.rec.saveDecision")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.rec.decided")} fieldIds={ids} />
    </form>
  );
}

/** A person's decision about one line no entry answers. */
export function ItemDecisionForm({
  personId,
  recId,
  itemId,
  allergies,
}: {
  readonly personId: string;
  readonly recId: string;
  readonly itemId: string;
  readonly allergies: ReactNode;
}) {
  const ids = useFieldIds([...DRAFT_FIELDS, "decision", "reason", "question"]);
  const [kind, setKind] = useState("");
  const [product, setProduct] = useState<ProductHit | null>(null);
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readItemDecision(form, t, itemId, product),
    (decision) => decideReconciliation(personId, recId, { on: "item", decision }),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.decision}
        name="decision"
        legend={t("medicines.rec.decide")}
        options={["start", "not_started", "query"].map((k) => ({
          value: k,
          label: t("medicines.rec.itemDecision", { kind: k }),
        }))}
        onValueChange={setKind}
        error={errorFor(result, "decision")}
      />
      {kind === "start" ? (
        <DraftFields
          product={product}
          onProduct={setProduct}
          result={result}
          ids={ids}
          allergies={allergies}
        />
      ) : null}
      {kind === "not_started" ? (
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("medicines.rec.notStartedReason")}
          rows={2}
          maxLength={2000}
          error={errorFor(result, "reason")}
        />
      ) : null}
      {kind === "query" ? (
        <TextArea
          id={ids.question}
          name="question"
          label={t("medicines.rec.question")}
          hint={t("medicines.rec.questionHint")}
          rows={2}
          maxLength={2000}
          error={errorFor(result, "question")}
        />
      ) : null}
      <div>
        <Button type="submit" variant="secondary" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.rec.saveDecision")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.rec.decided")} fieldIds={ids} />
    </form>
  );
}

/** Completion: allergies compared, the person's involvement, and the record applied at once. */
export function CompleteForm({
  personId,
  recId,
  version,
  isReturn,
  allergies,
}: {
  readonly personId: string;
  readonly recId: string;
  readonly version: number;
  readonly isReturn: boolean;
  readonly allergies: ReactNode;
}) {
  const ids = useFieldIds([
    "allergiesCompared",
    "involved",
    "notInvolvedReason",
    "noDischargeLetterReason",
  ]);
  const [involved, setInvolved] = useState("");
  const { result, pending, submit } = useMedicineSubmit(
    (form) => readCompletion(form, t, version),
    (body) => completeReconciliation(personId, recId, body),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("medicines.rec.completeIntro")}</p>
      {allergies}
      <Checkbox
        id={ids.allergiesCompared}
        name="allergiesCompared"
        value="yes"
        required
        label={t("medicines.rec.allergiesCompared")}
        error={errorFor(result, "allergiesCompared")}
      />
      <RadioGroup
        id={ids.involved}
        name="involved"
        legend={t("medicines.rec.involved")}
        options={[
          { value: "yes", label: t("medicines.rec.involvedYes") },
          { value: "no", label: t("medicines.rec.involvedNo") },
        ]}
        onValueChange={setInvolved}
        error={errorFor(result, "involved")}
      />
      {involved === "no" ? (
        <TextArea
          id={ids.notInvolvedReason}
          name="notInvolvedReason"
          label={t("medicines.rec.notInvolvedReason")}
          rows={2}
          maxLength={2000}
          error={errorFor(result, "notInvolvedReason")}
        />
      ) : null}
      {isReturn ? (
        <TextArea
          id={ids.noDischargeLetterReason}
          name="noDischargeLetterReason"
          label={t("medicines.rec.noDischargeLetter")}
          hint={t("medicines.rec.noDischargeLetterHint")}
          rows={2}
          maxLength={2000}
          error={errorFor(result, "noDischargeLetterReason")}
        />
      ) : null}
      <div>
        <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.rec.complete")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("medicines.rec.completed")} fieldIds={ids} />
    </form>
  );
}
