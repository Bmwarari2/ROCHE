"use client";

import { Button, Checkbox, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { CircleHelp, KeyRound, Trash2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  addPropertyItem,
  closeKey,
  disposePropertyItem,
  issueKey,
  losePropertyItem,
  returnPropertyItem,
} from "@/app/actions/property";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useEntryId, useFieldIds, useInlineForm } from "@/components/care/form-state";
import {
  MAX_QUANTITY,
  needsWitness,
  PROPERTY_CATEGORY_OPTIONS,
  PROPERTY_DESCRIPTION_MAX,
  readQuantity,
  type Signer,
  travelsWithPerson,
  valuableCategory,
} from "@/lib/admission";
import { characterCount, t } from "@/lib/i18n";
import { collectedRefusal, errorFor, type FieldProblem } from "@/lib/outcome";
import { readDateField } from "@/lib/uk-time";
import { type ActionForm, useActionForm } from "./action-form";
import { DateField } from "./DateField";
import { SignatureFields, WitnessPicker } from "./PropertyFields";

/**
 * Property, valuables and keys in and out (people.md rule 7; people.property.manage). Every form
 * says what it needs before it is sent and the API checks it all again. Cash is not a category:
 * residents' money goes to the ledger.
 */

const ADD_FIELDS = [
  "description",
  "category",
  "quantity",
  "valuable",
  "receivedOn",
  "ackSigner",
  "ackName",
  "ackUnableReason",
  "witness",
] as const;

/** Record an item in: described, counted, dated, signed for, and witnessed where it must be. */
export function AddPropertyForm({
  personId,
  today,
}: {
  readonly personId: string;
  readonly today: string;
}) {
  const form = useActionForm();
  const ids = useFieldIds(ADD_FIELDS);
  const entry = useEntryId();
  const [round, setRound] = useState(0);
  const [category, setCategory] = useState("");
  const [marked, setMarked] = useState(false);
  const [signer, setSigner] = useState<Signer | null>(null);
  const alwaysValuable = valuableCategory(category);
  const witnessed = needsWitness({ category, valuable: marked, signer });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const description = String(data.get("description") ?? "").trim();
    if (description.length < 3) {
      problems.push({
        field: "description",
        message: t("people.property.form.descriptionRequired"),
      });
    }
    if (!category) {
      problems.push({ field: "category", message: t("people.property.form.categoryRequired") });
    }
    const quantity = readQuantity(data.get("quantity"));
    if (quantity === null) {
      problems.push({ field: "quantity", message: t("people.property.form.quantityRequired") });
    }
    const received = readDateField(data, "receivedOn", {
      subject: t("people.property.form.receivedSubject"),
      t,
    });
    if (!received.ok) {
      problems.push({ field: "receivedOn", message: received.message, parts: received.parts });
    }
    if (!signer)
      problems.push({ field: "ackSigner", message: t("people.property.form.signerRequired") });
    const name = String(data.get("signerName") ?? "");
    const unableReason = String(data.get("unableReason") ?? "");
    if ((signer === "person" || signer === "representative") && !name.trim()) {
      problems.push({ field: "ackName", message: t("people.property.form.signerNameRequired") });
    }
    if (signer === "unable_to_sign" && unableReason.trim().length < 3) {
      problems.push({
        field: "ackUnableReason",
        message: t("people.property.form.unableReasonRequired"),
      });
    }
    const witness = data.get("witness");
    if (witnessed && typeof witness !== "string") {
      problems.push({ field: "witness", message: t("people.property.form.witnessRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !received.ok) {
      form.setResult(refusal);
      return;
    }
    form.run(
      () =>
        addPropertyItem(personId, {
          id: entry.id,
          description,
          category,
          quantity,
          valuable: marked || alwaysValuable,
          receivedOn: received.date ?? "",
          acknowledgement: { signer, name, unableReason },
          witness: typeof witness === "string" ? witness : null,
        }),
      () => {
        entry.next();
        setCategory("");
        setMarked(false);
        setSigner(null);
        setRound((n) => n + 1);
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <form method="post" key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          id={ids.description}
          name="description"
          label={t("people.property.form.description")}
          hint={t("people.property.form.descriptionHint")}
          maxLength={PROPERTY_DESCRIPTION_MAX}
          autoComplete="off"
          required
          error={errorFor(form.result, "description")}
        />
        <SelectField
          id={ids.category}
          name="category"
          label={t("people.property.form.category")}
          hint={t("people.property.form.categoryHint")}
          emptyOption={t("people.property.form.categoryChoose")}
          required
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          options={PROPERTY_CATEGORY_OPTIONS.map((value) => ({
            value,
            label: t("people.property.category", { category: value }),
          }))}
          error={errorFor(form.result, "category")}
          className="max-w-md"
        />
        {travelsWithPerson(category) ? (
          <p className="m-0">{t("people.property.form.travels")}</p>
        ) : null}
        <TextField
          id={ids.quantity}
          name="quantity"
          label={t("people.property.form.quantity")}
          inputMode="numeric"
          autoComplete="off"
          defaultValue="1"
          maxLength={String(MAX_QUANTITY).length}
          required
          error={errorFor(form.result, "quantity")}
          className="max-w-xs"
        />
        <Checkbox
          id={ids.valuable}
          name="valuable"
          label={t("people.property.form.valuable")}
          hint={
            alwaysValuable
              ? t("people.property.form.valuableAlways")
              : t("people.property.form.valuableHint")
          }
          checked={marked || alwaysValuable}
          disabled={alwaysValuable}
          onChange={(event) => setMarked(event.target.checked)}
        />
        <DateField
          id={ids.receivedOn}
          name="receivedOn"
          legend={t("people.property.form.receivedOn")}
          result={form.result}
          defaultValue={today}
        />
        <SignatureFields
          ids={{ signer: ids.ackSigner, name: ids.ackName, unableReason: ids.ackUnableReason }}
          errors={{
            signer: errorFor(form.result, "ackSigner"),
            name: errorFor(form.result, "ackName"),
            unableReason: errorFor(form.result, "ackUnableReason"),
          }}
          legend={t("people.property.form.ackLegend")}
          signer={signer}
          onSignerChange={setSigner}
        />
        {witnessed ? (
          <WitnessPicker
            id={ids.witness}
            error={errorFor(form.result, "witness")}
            reason={
              signer === "unable_to_sign"
                ? t("people.property.witness.whyUnsigned")
                : t("people.property.witness.whyValuable")
            }
          />
        ) : null}
        <div>
          <Button type="submit" disabled={form.pending}>
            {form.pending ? t("common.saving") : t("people.property.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={form.result} success={t("people.property.form.saved")} fieldIds={ids} />
    </div>
  );
}

export type PropertyDone = "returned" | "disposed" | "lost" | "keyReturned" | "keyLost";

/**
 * After an item or key leaves, the tab is drawn again with it among the closed ones; the tab says
 * what happened and takes focus there, as the outage pages do, so nothing is lost with the form.
 */
function useArrival(personId: string) {
  const router = useRouter();
  return (done: PropertyDone) =>
    router.push(`/people/${personId}/property?done=${done}&at=${Date.now().toString(36)}`, {
      scroll: false,
    });
}

/** An action on one item that opens in place from its button; Cancel puts focus back on it. */
function InlineItemAction({
  form,
  inline,
  open,
  icon,
  firstFieldId,
  success,
  fieldIds,
  children,
}: {
  readonly form: ActionForm;
  readonly inline: ReturnType<typeof useInlineForm<HTMLElement>>;
  readonly open: string;
  readonly icon: ReactNode;
  readonly firstFieldId: string;
  readonly success: string;
  readonly fieldIds: Readonly<Record<string, string>>;
  readonly children: ReactNode;
}) {
  useEffect(() => {
    if (inline.open) document.getElementById(firstFieldId)?.focus();
  }, [inline.open, firstFieldId]);
  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        children
      ) : (
        <div>
          <Button
            ref={inline.trigger}
            variant="secondary"
            icon={icon}
            onClick={() => {
              form.setResult(null);
              inline.show();
            }}
          >
            {open}
          </Button>
        </div>
      )}
      <FormFeedback result={form.result} success={success} fieldIds={fieldIds} />
    </div>
  );
}

function Actions({
  form,
  inline,
  submit,
  destructive = false,
}: {
  readonly form: ActionForm;
  readonly inline: ReturnType<typeof useInlineForm<HTMLElement>>;
  readonly submit: string;
  readonly destructive?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="submit"
        variant={destructive ? "destructive" : "primary"}
        disabled={form.pending}
      >
        {form.pending ? t("common.saving") : submit}
      </Button>
      <Button
        variant="secondary"
        onClick={() => {
          form.setResult(null);
          inline.hide();
        }}
      >
        {t("common.cancel")}
      </Button>
    </div>
  );
}

interface ItemRef {
  readonly personId: string;
  readonly itemId: string;
  readonly description: string;
  readonly valuable: boolean;
  readonly version: number;
  readonly today: string;
}

const RETURN_FIELDS = [
  "returnedOn",
  "recipientName",
  "recipientCapacity",
  "returnSigner",
  "returnName",
  "returnUnableReason",
  "witness",
] as const;

/**
 * Return an item: to whom (after a death only the personal representative), who signed or why
 * nobody could, and a witness for valuables and unsigned returns.
 */
export function ReturnPropertyForm(
  props: ItemRef & {
    readonly capacities: readonly (
      | "person"
      | "representative"
      | "personal_representative"
      | "receiving_provider"
    )[];
  },
) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLElement>();
  const ids = useFieldIds(RETURN_FIELDS);
  const arrive = useArrival(props.personId);
  const [signer, setSigner] = useState<Signer | null>(null);
  const witnessed = props.valuable || signer === "unable_to_sign";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const on = readDateField(data, "returnedOn", {
      subject: t("people.property.return.dateSubject"),
      t,
    });
    if (!on.ok) problems.push({ field: "returnedOn", message: on.message, parts: on.parts });
    const recipientName = String(data.get("recipientName") ?? "");
    if (!recipientName.trim()) {
      problems.push({
        field: "recipientName",
        message: t("people.property.return.recipientRequired"),
      });
    }
    const capacity = data.get("recipientCapacity");
    if (typeof capacity !== "string") {
      problems.push({
        field: "recipientCapacity",
        message: t("people.property.return.capacityRequired"),
      });
    }
    if (!signer) {
      problems.push({ field: "returnSigner", message: t("people.property.form.signerRequired") });
    }
    const name = String(data.get("signerName") ?? "");
    const unableReason = String(data.get("unableReason") ?? "");
    if ((signer === "person" || signer === "representative") && !name.trim()) {
      problems.push({ field: "returnName", message: t("people.property.form.signerNameRequired") });
    }
    if (signer === "unable_to_sign" && unableReason.trim().length < 3) {
      problems.push({
        field: "returnUnableReason",
        message: t("people.property.form.unableReasonRequired"),
      });
    }
    const witness = data.get("witness");
    if (witnessed && typeof witness !== "string") {
      problems.push({ field: "witness", message: t("people.property.form.witnessRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !on.ok) {
      form.setResult(refusal);
      return;
    }
    form.run(
      () =>
        returnPropertyItem(props.personId, props.itemId, {
          returnedOn: on.date ?? "",
          recipientName,
          recipientCapacity: typeof capacity === "string" ? capacity : null,
          signature: { signer, name, unableReason },
          witness: typeof witness === "string" ? witness : null,
          valuable: props.valuable,
          version: props.version,
        }),
      () => arrive("returned"),
    );
  };
  return (
    <InlineItemAction
      form={form}
      inline={inline}
      open={t("people.property.return.open", { item: props.description })}
      icon={<Undo2 size={16} strokeWidth={1.5} />}
      firstFieldId={`${ids.returnedOn}`}
      success={t("people.property.return.saved")}
      fieldIds={ids}
    >
      <form
        method="post"
        className="flex flex-col gap-4 border-s-4 border-border ps-4"
        onSubmit={submit}
        noValidate
      >
        <DateField
          id={ids.returnedOn}
          name="returnedOn"
          legend={t("people.property.return.date")}
          result={form.result}
          defaultValue={props.today}
        />
        <TextField
          id={ids.recipientName}
          name="recipientName"
          label={t("people.property.return.recipient")}
          autoComplete="off"
          maxLength={200}
          required
          error={errorFor(form.result, "recipientName")}
          className="max-w-md"
        />
        <RadioGroup
          id={ids.recipientCapacity}
          name="recipientCapacity"
          legend={t("people.property.return.capacity")}
          hint={props.capacities.length === 1 ? t("people.property.return.afterDeath") : undefined}
          required
          error={errorFor(form.result, "recipientCapacity")}
          options={props.capacities.map((value) => ({
            value,
            label: t("people.property.capacity", { capacity: value }),
          }))}
        />
        <SignatureFields
          ids={{
            signer: ids.returnSigner,
            name: ids.returnName,
            unableReason: ids.returnUnableReason,
          }}
          errors={{
            signer: errorFor(form.result, "returnSigner"),
            name: errorFor(form.result, "returnName"),
            unableReason: errorFor(form.result, "returnUnableReason"),
          }}
          legend={t("people.property.return.signedBy")}
          signer={signer}
          onSignerChange={setSigner}
        />
        {witnessed ? (
          <WitnessPicker
            id={ids.witness}
            error={errorFor(form.result, "witness")}
            reason={
              props.valuable
                ? t("people.property.witness.whyValuable")
                : t("people.property.witness.whyUnsigned")
            }
          />
        ) : null}
        <Actions form={form} inline={inline} submit={t("people.property.return.submit")} />
      </form>
    </InlineItemAction>
  );
}

const DISPOSE_FIELDS = ["on", "reason", "witness"] as const;

/** Dispose of an item, with the reason and a witness. */
export function DisposePropertyForm(props: ItemRef) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLElement>();
  const ids = useFieldIds(DISPOSE_FIELDS);
  const arrive = useArrival(props.personId);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const on = readDateField(data, "on", { subject: t("people.property.dispose.dateSubject"), t });
    if (!on.ok) problems.push({ field: "on", message: on.message, parts: on.parts });
    const reason = String(data.get("reason") ?? "");
    if (reason.trim().length < 3) {
      problems.push({ field: "reason", message: t("people.property.dispose.reasonRequired") });
    }
    const witness = data.get("witness");
    if (typeof witness !== "string") {
      problems.push({ field: "witness", message: t("people.property.form.witnessRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !on.ok) {
      form.setResult(refusal);
      return;
    }
    form.run(
      () =>
        disposePropertyItem(props.personId, props.itemId, {
          on: on.date ?? "",
          reason,
          witness: typeof witness === "string" ? witness : null,
          version: props.version,
        }),
      () => arrive("disposed"),
    );
  };
  return (
    <InlineItemAction
      form={form}
      inline={inline}
      open={t("people.property.dispose.open", { item: props.description })}
      icon={<Trash2 size={16} strokeWidth={1.5} />}
      firstFieldId={ids.on}
      success={t("people.property.dispose.saved")}
      fieldIds={ids}
    >
      <form
        method="post"
        className="flex flex-col gap-4 border-s-4 border-border ps-4"
        onSubmit={submit}
        noValidate
      >
        <p className="m-0 font-semibold">{t("people.property.dispose.consequence")}</p>
        <DateField
          id={ids.on}
          name="on"
          legend={t("people.property.dispose.date")}
          result={form.result}
          defaultValue={props.today}
        />
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("people.property.dispose.reason")}
          rows={2}
          required
          maxLength={500}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(form.result, "reason")}
        />
        <WitnessPicker
          id={ids.witness}
          error={errorFor(form.result, "witness")}
          reason={t("people.property.witness.whyDisposal")}
        />
        <Actions
          form={form}
          inline={inline}
          submit={t("people.property.dispose.submit")}
          destructive
        />
      </form>
    </InlineItemAction>
  );
}

const LOSE_FIELDS = ["on", "incidentId"] as const;

/** Record an item as lost, with the incident raised for it (rule 7). */
export function LosePropertyForm(
  props: ItemRef & {
    readonly incidents: readonly { readonly id: string; readonly label: string }[] | null;
  },
) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLElement>();
  const ids = useFieldIds(LOSE_FIELDS);
  const arrive = useArrival(props.personId);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const on = readDateField(data, "on", { subject: t("people.property.lose.dateSubject"), t });
    if (!on.ok) problems.push({ field: "on", message: on.message, parts: on.parts });
    const incidentId = String(data.get("incidentId") ?? "");
    if (!incidentId) {
      problems.push({ field: "incidentId", message: t("people.property.lose.incidentRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !on.ok) {
      form.setResult(refusal);
      return;
    }
    form.run(
      () =>
        losePropertyItem(props.personId, props.itemId, {
          on: on.date ?? "",
          incidentId,
          version: props.version,
        }),
      () => arrive("lost"),
    );
  };
  return (
    <InlineItemAction
      form={form}
      inline={inline}
      open={t("people.property.lose.open", { item: props.description })}
      icon={<CircleHelp size={16} strokeWidth={1.5} />}
      firstFieldId={ids.on}
      success={t("people.property.lose.saved")}
      fieldIds={ids}
    >
      <form
        method="post"
        className="flex flex-col gap-4 border-s-4 border-border ps-4"
        onSubmit={submit}
        noValidate
      >
        <p className="m-0 font-semibold">{t("people.property.lose.consequence")}</p>
        <DateField
          id={ids.on}
          name="on"
          legend={t("people.property.lose.date")}
          result={form.result}
          defaultValue={props.today}
        />
        {props.incidents && props.incidents.length > 0 ? (
          <SelectField
            id={ids.incidentId}
            name="incidentId"
            label={t("people.property.lose.incident")}
            hint={t("people.property.lose.incidentHint")}
            emptyOption={t("people.property.lose.incidentChoose")}
            required
            options={props.incidents.map((incident) => ({
              value: incident.id,
              label: incident.label,
            }))}
            error={errorFor(form.result, "incidentId")}
            className="max-w-md"
          />
        ) : (
          <p id={ids.incidentId} tabIndex={-1} className="m-0 font-semibold">
            {t("people.property.lose.noIncident")}
          </p>
        )}
        <Actions
          form={form}
          inline={inline}
          submit={t("people.property.lose.submit")}
          destructive
        />
      </form>
    </InlineItemAction>
  );
}

const KEY_FIELDS = ["label", "issuedOn", "issuedTo"] as const;

/** Issue a key or fob to the person or their representative. */
export function IssueKeyForm({
  personId,
  today,
}: {
  readonly personId: string;
  readonly today: string;
}) {
  const form = useActionForm();
  const ids = useFieldIds(KEY_FIELDS);
  const entry = useEntryId();
  const [round, setRound] = useState(0);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const label = String(data.get("label") ?? "");
    if (!label.trim())
      problems.push({ field: "label", message: t("people.keys.form.labelRequired") });
    const on = readDateField(data, "issuedOn", { subject: t("people.keys.form.dateSubject"), t });
    if (!on.ok) problems.push({ field: "issuedOn", message: on.message, parts: on.parts });
    const issuedTo = data.get("issuedTo");
    if (typeof issuedTo !== "string") {
      problems.push({ field: "issuedTo", message: t("people.keys.form.issuedToRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !on.ok) {
      form.setResult(refusal);
      return;
    }
    form.run(
      () =>
        issueKey(personId, {
          id: entry.id,
          label,
          issuedOn: on.date ?? "",
          issuedTo: typeof issuedTo === "string" ? issuedTo : null,
        }),
      () => {
        entry.next();
        setRound((n) => n + 1);
      },
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <form method="post" key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          id={ids.label}
          name="label"
          label={t("people.keys.form.label")}
          hint={t("people.keys.form.labelHint")}
          autoComplete="off"
          maxLength={120}
          required
          error={errorFor(form.result, "label")}
          className="max-w-md"
        />
        <DateField
          id={ids.issuedOn}
          name="issuedOn"
          legend={t("people.keys.form.issuedOn")}
          result={form.result}
          defaultValue={today}
        />
        <RadioGroup
          id={ids.issuedTo}
          name="issuedTo"
          legend={t("people.keys.form.issuedTo")}
          layout="inline"
          required
          error={errorFor(form.result, "issuedTo")}
          options={(["person", "representative"] as const).map((value) => ({
            value,
            label: t("people.keys.issuedTo", { to: value }),
          }))}
        />
        <div>
          <Button
            type="submit"
            icon={<KeyRound size={16} strokeWidth={1.5} />}
            disabled={form.pending}
          >
            {form.pending ? t("common.saving") : t("people.keys.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={form.result} success={t("people.keys.form.saved")} fieldIds={ids} />
    </div>
  );
}

const CLOSE_FIELDS = ["on"] as const;

/** A key came back, or was reported lost: the day it happened. */
export function CloseKeyForm({
  personId,
  keyId,
  label,
  how,
  version,
  today,
}: {
  readonly personId: string;
  readonly keyId: string;
  readonly label: string;
  readonly how: "returned" | "lost";
  readonly version: number;
  readonly today: string;
}) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLElement>();
  const ids = useFieldIds(CLOSE_FIELDS);
  const arrive = useArrival(personId);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const on = readDateField(data, "on", {
      subject: t("people.keys.close.dateSubject", { how }),
      t,
    });
    if (!on.ok) {
      form.setResult(collectedRefusal([{ field: "on", message: on.message, parts: on.parts }]));
      return;
    }
    form.run(
      () => closeKey(personId, keyId, how, { on: on.date ?? "", version }),
      () => arrive(how === "returned" ? "keyReturned" : "keyLost"),
    );
  };
  return (
    <InlineItemAction
      form={form}
      inline={inline}
      open={t("people.keys.close.open", { how, label })}
      icon={
        how === "returned" ? (
          <Undo2 size={16} strokeWidth={1.5} />
        ) : (
          <CircleHelp size={16} strokeWidth={1.5} />
        )
      }
      firstFieldId={ids.on}
      success={t("people.keys.close.saved", { how })}
      fieldIds={ids}
    >
      <form
        method="post"
        className="flex flex-col gap-4 border-s-4 border-border ps-4"
        onSubmit={submit}
        noValidate
      >
        {how === "lost" ? (
          <p className="m-0 font-semibold">{t("people.keys.close.lostConsequence")}</p>
        ) : null}
        <DateField
          id={ids.on}
          name="on"
          legend={t("people.keys.close.date", { how })}
          result={form.result}
          defaultValue={today}
        />
        <Actions
          form={form}
          inline={inline}
          submit={t("people.keys.close.submit", { how })}
          destructive={how === "lost"}
        />
      </form>
    </InlineItemAction>
  );
}
