"use client";

import type { ExitDetails } from "@harbour/contracts";
import { Button, Card, Checkbox, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import {
  archiveRecord,
  closeKey,
  moveExit,
  planExit,
  recordDeath,
  recordLeaving,
  returnProperty,
  updateExitItem,
} from "@/app/actions/exit";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import { WhenField } from "@/components/care/WhenField";
import { StepUpNotice } from "@/components/safety/ManageForms";
import { ITEM_REASON_MAX, MOVE_REASON_MAX } from "@/lib/exit";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors, partsFor } from "@/lib/outcome";
import { readWhen } from "@/lib/uk-time";

/**
 * The Leaving tab's forms (PEOP-010). Each sends one write through a server action; on success the
 * tab opens again with `done`, which says what was done in a status and starts at the heading
 * (RecordedArrival). A refusal is a summary that takes focus, linked to its fields; a step that
 * needs step-up (the person's money or deposit) asks for the passkey or authenticator code, with
 * the way back. Every rule is the API's.
 */

export type ExitDone =
  | "planned"
  | "left"
  | "death"
  | "item"
  | "awaiting"
  | "closed"
  | "archived"
  | "cancelled"
  | "returned";

function useExitSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (done: ExitDone, call: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) router.replace(`${path}?done=${done}&at=${Date.now()}`, { scroll: false });
    });
  return { result, setResult, pending, send };
}

function Feedback({
  result,
  path,
  fieldIds,
}: {
  readonly result: ActionResult<unknown> | null;
  readonly path: string;
  readonly fieldIds?: Readonly<Record<string, string>>;
}) {
  if (!result || result.ok) return null;
  if (result.code === "step_up_required" || result.code === "mfa_verification_required") {
    return <StepUpNotice next={path} refusal={result} body={t("people.exit.stepUp")} />;
  }
  return <FormFeedback result={result} success="" {...(fieldIds ? { fieldIds } : {})} />;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const flag = (form: FormData, name: string) => form.get(name) === "on";

/** The flags the record cannot tell, as ticked on the form. */
function heldFlags(form: FormData) {
  return {
    holdsResidentsMoney: flag(form, "holdsResidentsMoney"),
    holdsDeposit: flag(form, "holdsDeposit"),
    hasLoanEquipment: flag(form, "hasLoanEquipment"),
    homeIsDwpAppointee: flag(form, "homeIsDwpAppointee"),
  };
}

/** What a planned exit already says, so recording that the person has left keeps it. */
export interface PlannedDefaults {
  readonly holdsResidentsMoney: boolean;
  readonly holdsDeposit: boolean;
  readonly hasLoanEquipment: boolean;
  readonly homeIsDwpAppointee: boolean;
  readonly destinationType: string | null;
  readonly receivingProviderName: string | null;
  readonly reason: string | null;
}

function HeldFlags({ defaults }: { readonly defaults?: PlannedDefaults }) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-2 font-semibold">{t("people.exit.flags.legend")}</legend>
      <p className="m-0 text-body-dense text-text-secondary">{t("people.exit.flags.hint")}</p>
      <Checkbox
        name="holdsResidentsMoney"
        defaultChecked={defaults?.holdsResidentsMoney ?? false}
        label={t("people.exit.flags.holdsResidentsMoney")}
      />
      <Checkbox
        name="holdsDeposit"
        defaultChecked={defaults?.holdsDeposit ?? false}
        label={t("people.exit.flags.holdsDeposit")}
      />
      <Checkbox
        name="hasLoanEquipment"
        defaultChecked={defaults?.hasLoanEquipment ?? false}
        label={t("people.exit.flags.hasLoanEquipment")}
      />
      <Checkbox
        name="homeIsDwpAppointee"
        defaultChecked={defaults?.homeIsDwpAppointee ?? false}
        label={t("people.exit.flags.homeIsDwpAppointee")}
      />
    </fieldset>
  );
}

const DESTINATIONS = [
  "own_home",
  "family_home",
  "care_home",
  "hospital",
  "hospice",
  "supported_living",
  "other",
] as const;

type Destination = (typeof DESTINATIONS)[number];

function Section({
  title,
  intro,
  children,
}: {
  readonly title: string;
  readonly intro: string;
  readonly children: ReactNode;
}) {
  return (
    <Card as="section" title={title} description={intro} headingLevel={3}>
      {children}
    </Card>
  );
}

/**
 * Plan a discharge or transfer (`mode: "plan"`), record one now (`"record"`), or record that a
 * planned one has happened (`"left"`, the kind and flags already set by the plan).
 */
export function LeavingForm({
  personId,
  path,
  version,
  mode,
  plannedKind,
  planned,
}: {
  readonly personId: string;
  readonly path: string;
  readonly version: number;
  readonly mode: "plan" | "record" | "left";
  readonly plannedKind?: "discharge" | "transfer";
  /** For `"left"`: the plan's flags, destination and reason, shown filled in and sent again. */
  readonly planned?: PlannedDefaults;
}) {
  const { result, setResult, pending, send } = useExitSend(path);
  const ids = useFieldIds([
    "exitKind",
    "effectiveAt",
    "reason",
    "destinationType",
    "receivingProviderName",
  ]);
  const [kind, setKind] = useState<"discharge" | "transfer" | null>(plannedKind ?? null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const exitKind = plannedKind ?? kind;
    const errors: Record<string, string> = {};
    if (!exitKind) errors.exitKind = t("people.exit.kindRequired");
    const reason = text(form, "reason");
    if (mode !== "plan" && reason.length === 0) errors.reason = t("people.exit.reasonRequired");
    const when =
      mode === "plan"
        ? null
        : readWhen(form, "effectiveAt", t, {
            subject: t("people.exit.whenSubject"),
          });
    if (when && !when.ok) errors.effectiveAt = when.message;
    if (Object.keys(errors).length > 0 || !exitKind) {
      setResult({
        ...fieldErrors(errors),
        ...(when && !when.ok ? { parts: { effectiveAt: when.parts } } : {}),
      });
      return;
    }
    const destination = text(form, "destinationType") as Destination | "";
    const provider = text(form, "receivingProviderName");
    const details: ExitDetails = {
      ...(destination ? { destinationType: destination } : {}),
      ...(provider ? { receivingProviderName: provider } : {}),
      ...(reason ? { reason } : {}),
      ...heldFlags(form),
    };
    if (mode === "plan") {
      send("planned", () => planExit(personId, { kind: exitKind, details }));
      return;
    }
    send("left", () =>
      recordLeaving(personId, {
        exitKind,
        effectiveAt: when?.ok ? when.instant : "",
        reason,
        details,
        version,
      }),
    );
  };

  const title = t(`people.exit.leaving.title`, { mode });
  return (
    <Section title={title} intro={t("people.exit.leaving.intro", { mode })}>
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={submit}
        noValidate
        aria-label={title}
      >
        {plannedKind ? null : (
          <RadioGroup<"discharge" | "transfer">
            id={ids.exitKind}
            name="exitKind"
            legend={t("people.exit.kind.legend")}
            value={kind}
            onValueChange={setKind}
            error={errorFor(result, "exitKind")}
            options={[
              {
                value: "discharge",
                label: t("people.exit.kind", { kind: "discharge" }),
                description: t("people.exit.kind.dischargeHint"),
              },
              {
                value: "transfer",
                label: t("people.exit.kind", { kind: "transfer" }),
                description: t("people.exit.kind.transferHint"),
              },
            ]}
          />
        )}
        {mode === "plan" ? null : (
          <WhenField
            name="effectiveAt"
            id={ids.effectiveAt}
            legend={t("people.exit.leftWhen")}
            error={errorFor(result, "effectiveAt")}
            errorParts={partsFor(result, "effectiveAt")}
          />
        )}
        <SelectField
          id={ids.destinationType}
          name="destinationType"
          label={t("people.exit.destination.label")}
          emptyOption={t("people.exit.destination.empty")}
          defaultValue={planned?.destinationType ?? ""}
          options={DESTINATIONS.map((value) => ({
            value,
            label: t("people.exit.destination", { destination: value }),
          }))}
        />
        {(plannedKind ?? kind) === "transfer" ? (
          <TextField
            id={ids.receivingProviderName}
            name="receivingProviderName"
            label={t("people.exit.receivingProvider")}
            maxLength={200}
            defaultValue={planned?.receivingProviderName ?? ""}
          />
        ) : null}
        <TextArea
          id={ids.reason}
          name="reason"
          label={mode === "plan" ? t("people.exit.reasonOptional") : t("people.exit.reason")}
          defaultValue={planned?.reason ?? ""}
          maxLength={MOVE_REASON_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "reason")}
        />
        <HeldFlags {...(planned ? { defaults: planned } : {})} />
        <div>
          <Button type="submit" disabled={pending}>
            {t("people.exit.leaving.submit", { mode })}
          </Button>
        </div>
        <Feedback result={result} path={path} fieldIds={ids} />
      </form>
    </Section>
  );
}

type YesNo = "yes" | "no";

/** Record a death (people.movement.record): when, where, whether expected, and LeDeR. */
export function DeathForm({
  personId,
  path,
  version,
  inHospital,
}: {
  readonly personId: string;
  readonly path: string;
  readonly version: number;
  /** The person is in hospital: where they died defaults to the hospital. */
  readonly inHospital: boolean;
}) {
  const { result, setResult, pending, send } = useExitSend(path);
  const ids = useFieldIds([
    "effectiveAt",
    "placeOfDeath",
    "deathExpected",
    "learningDisabilityOrAutism",
    "verifiedByName",
  ]);
  const [place, setPlace] = useState<"care_home" | "hospital" | "elsewhere">(
    inHospital ? "hospital" : "care_home",
  );
  const [expected, setExpected] = useState<YesNo | null>(null);
  const [leder, setLeder] = useState<YesNo | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const errors: Record<string, string> = {};
    const when = readWhen(form, "effectiveAt", t, { subject: t("people.exit.diedSubject") });
    if (!when.ok) errors.effectiveAt = when.message;
    if (!expected) errors.deathExpected = t("people.exit.death.expectedRequired");
    if (!leder) errors.learningDisabilityOrAutism = t("people.exit.death.lederRequired");
    if (!when.ok || !expected || !leder) {
      setResult({
        ...fieldErrors(errors),
        ...(!when.ok ? { parts: { effectiveAt: when.parts } } : {}),
      });
      return;
    }
    const verifiedByName = text(form, "verifiedByName");
    const verifiedByRole = text(form, "verifiedByRole");
    const funeralDirector = text(form, "funeralDirector");
    send("death", () =>
      recordDeath(personId, {
        effectiveAt: when.instant,
        version,
        details: {
          placeOfDeath: place,
          deathExpected: expected === "yes",
          learningDisabilityOrAutism: leder === "yes",
          ...(verifiedByName ? { verifiedByName } : {}),
          ...(verifiedByRole ? { verifiedByRole } : {}),
          ...(funeralDirector ? { funeralDirector } : {}),
          ...heldFlags(form),
        },
      }),
    );
  };

  const yesNo = (yes: string, no: string) => [
    { value: "yes" as const, label: yes },
    { value: "no" as const, label: no },
  ];
  return (
    <Section title={t("people.exit.death.title")} intro={t("people.exit.death.intro")}>
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={submit}
        noValidate
        aria-label={t("people.exit.death.title")}
      >
        <WhenField
          name="effectiveAt"
          id={ids.effectiveAt}
          legend={t("people.exit.death.when")}
          error={errorFor(result, "effectiveAt")}
          errorParts={partsFor(result, "effectiveAt")}
        />
        <RadioGroup<"care_home" | "hospital" | "elsewhere">
          id={ids.placeOfDeath}
          name="placeOfDeath"
          legend={t("people.exit.death.place")}
          value={place}
          onValueChange={setPlace}
          options={(["care_home", "hospital", "elsewhere"] as const).map((value) => ({
            value,
            label: t("people.exit.death.placeOption", { place: value }),
          }))}
        />
        <RadioGroup<YesNo>
          id={ids.deathExpected}
          name="deathExpected"
          legend={t("people.exit.death.expected")}
          hint={t("people.exit.death.expectedHint")}
          value={expected}
          onValueChange={setExpected}
          error={errorFor(result, "deathExpected")}
          options={yesNo(t("people.exit.death.expectedYes"), t("people.exit.death.expectedNo"))}
        />
        <RadioGroup<YesNo>
          id={ids.learningDisabilityOrAutism}
          name="learningDisabilityOrAutism"
          legend={t("people.exit.death.leder")}
          hint={t("people.exit.death.lederHint")}
          value={leder}
          onValueChange={setLeder}
          error={errorFor(result, "learningDisabilityOrAutism")}
          options={yesNo(t("people.exit.yes"), t("people.exit.no"))}
        />
        <TextField
          id={ids.verifiedByName}
          name="verifiedByName"
          label={t("people.exit.death.verifiedByName")}
          maxLength={200}
        />
        <TextField
          name="verifiedByRole"
          label={t("people.exit.death.verifiedByRole")}
          maxLength={120}
        />
        <TextField
          name="funeralDirector"
          label={t("people.exit.death.funeralDirector")}
          maxLength={200}
        />
        <HeldFlags />
        <div>
          <Button type="submit" disabled={pending}>
            {t("people.exit.death.submit")}
          </Button>
        </div>
        <Feedback result={result} path={path} fieldIds={ids} />
      </form>
    </Section>
  );
}

/**
 * One checklist item's actions: mark it done, not required with a reason (where allowed), or to
 * do again. The item's title names each button for screen readers.
 */
export function ItemActions({
  personId,
  path,
  itemKey,
  itemTitle,
  status,
  allowNotRequired,
  version,
}: {
  readonly personId: string;
  readonly path: string;
  readonly itemKey: string;
  readonly itemTitle: string;
  readonly status: "pending" | "done" | "not_required";
  readonly allowNotRequired: boolean;
  readonly version: number;
}) {
  const { result, setResult, pending, send } = useExitSend(path);
  const inline = useInlineForm<HTMLTextAreaElement>();
  const ids = useFieldIds(["reason"]);
  const update = (next: "pending" | "done" | "not_required", reason?: string) =>
    send("item", () =>
      updateExitItem(personId, itemKey, {
        status: next,
        ...(reason !== undefined ? { reason } : {}),
        version,
      }),
    );

  if (status !== "pending") {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button
            variant="tertiary"
            disabled={pending}
            aria-label={t("people.exit.undoNamed", { item: itemTitle })}
            onClick={() => update("pending")}
          >
            {t("people.exit.undo")}
          </Button>
        </div>
        <Feedback result={result} path={path} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form
          method="post"
          className="flex flex-col gap-3"
          noValidate
          aria-label={t("people.exit.notRequiredNamed", { item: itemTitle })}
          onSubmit={(event) => {
            event.preventDefault();
            const reason = text(new FormData(event.currentTarget), "reason");
            if (reason.length === 0) {
              setResult(fieldErrors({ reason: t("people.exit.notRequiredReasonRequired") }));
              return;
            }
            update("not_required", reason);
          }}
        >
          <TextArea
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={t("people.exit.notRequiredReason", { item: itemTitle })}
            maxLength={ITEM_REASON_MAX}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {t("people.exit.saveNotRequired")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                inline.hide();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={pending}
            aria-label={t("people.exit.markDoneNamed", { item: itemTitle })}
            onClick={() => update("done")}
          >
            {t("people.exit.markDone")}
          </Button>
          {allowNotRequired ? (
            <Button
              ref={inline.trigger}
              variant="tertiary"
              aria-label={t("people.exit.notRequiredNamed", { item: itemTitle })}
              onClick={() => {
                setResult(null);
                inline.show();
              }}
            >
              {t("people.exit.markNotRequired")}
            </Button>
          ) : null}
        </div>
      )}
      <Feedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

/** Move to waiting for returns, close the checklist, or archive the record: one button each. */
export function MoveButton({
  personId,
  path,
  move,
  version,
}: {
  readonly personId: string;
  readonly path: string;
  readonly move: "awaitReturns" | "close" | "archive";
  readonly version: number;
}) {
  const { result, pending, send } = useExitSend(path);
  const [confirming, setConfirming] = useState(false);
  const hintId = useFieldIds(["hint"]).hint;
  const click = () => {
    if (move === "archive") send("archived", () => archiveRecord(personId, { version }));
    else if (move === "close") send("closed", () => moveExit(personId, { to: "closed", version }));
    else send("awaiting", () => moveExit(personId, { to: "awaiting_return", version }));
  };
  // Archiving cannot be undone: it asks again, saying what it does (CONTENT.md rule 4).
  return (
    <div className="flex flex-col gap-2">
      <p id={hintId} className="m-0 max-w-prose">
        {t("people.exit.move.hint", { move })}
      </p>
      {move === "archive" && confirming ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 font-semibold">{t("people.exit.archiveConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" disabled={pending} onClick={click}>
              {t("people.exit.archiveConfirmButton")}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("people.exit.archiveKeep")}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            variant={move === "archive" ? "destructive" : "primary"}
            disabled={pending}
            aria-describedby={hintId}
            onClick={move === "archive" ? () => setConfirming(true) : click}
          >
            {t("people.exit.move.button", { move })}
          </Button>
        </div>
      )}
      <Feedback result={result} path={path} />
    </div>
  );
}

/** Cancel a planned discharge or transfer, with the reason. */
export function CancelPlan({
  personId,
  path,
  version,
}: {
  readonly personId: string;
  readonly path: string;
  readonly version: number;
}) {
  const { result, setResult, pending, send } = useExitSend(path);
  const inline = useInlineForm<HTMLTextAreaElement>();
  const ids = useFieldIds(["reason"]);
  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form
          method="post"
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const reason = text(new FormData(event.currentTarget), "reason");
            if (reason.length === 0) {
              setResult(fieldErrors({ reason: t("people.exit.cancelReasonRequired") }));
              return;
            }
            send("cancelled", () => moveExit(personId, { to: "cancelled", reason, version }));
          }}
        >
          <TextArea
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={t("people.exit.cancelReason")}
            maxLength={MOVE_REASON_MAX}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {t("people.exit.cancelPlanSubmit")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                inline.hide();
              }}
            >
              {t("people.exit.keepPlan")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button ref={inline.trigger} variant="secondary" onClick={inline.show}>
            {t("people.exit.cancelPlan")}
          </Button>
        </div>
      )}
      <Feedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

type Capacity = "person" | "representative" | "personal_representative" | "receiving_provider";
type Signer = "person" | "representative" | "unable_to_sign";

/** Record that an item of property was returned today: who received it and who signed. */
export function PropertyReturn({
  personId,
  path,
  itemId,
  description,
  version,
  death,
}: {
  readonly personId: string;
  readonly path: string;
  readonly itemId: string;
  readonly description: string;
  readonly version: number;
  /** After a death, property goes to the personal representative by default. */
  readonly death: boolean;
}) {
  const { result, setResult, pending, send } = useExitSend(path);
  const inline = useInlineForm<HTMLInputElement>();
  const ids = useFieldIds(["recipientName", "signerName", "unableReason"]);
  const [capacity, setCapacity] = useState<Capacity>(death ? "personal_representative" : "person");
  const [signer, setSigner] = useState<Signer>(death ? "representative" : "person");
  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form
          method="post"
          className="flex flex-col gap-3"
          noValidate
          aria-label={t("people.exit.returns.formLabel", { item: description })}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setResult(null);
            send("returned", () =>
              returnProperty(personId, itemId, {
                recipientName: text(form, "recipientName"),
                recipientCapacity: capacity,
                signer,
                signerName: text(form, "signerName"),
                unableReason: text(form, "unableReason"),
                version,
              }),
            );
          }}
        >
          <TextField
            ref={inline.firstField}
            id={ids.recipientName}
            name="recipientName"
            label={t("people.exit.returns.recipientName")}
            maxLength={200}
            error={errorFor(result, "recipientName")}
          />
          <RadioGroup<Capacity>
            name="recipientCapacity"
            legend={t("people.exit.returns.capacity")}
            value={capacity}
            onValueChange={setCapacity}
            options={(
              ["person", "representative", "personal_representative", "receiving_provider"] as const
            ).map((value) => ({
              value,
              label: t("people.exit.returns.capacityOption", { value }),
            }))}
          />
          <RadioGroup<Signer>
            name="signer"
            legend={t("people.exit.returns.signer")}
            value={signer}
            onValueChange={setSigner}
            options={(["person", "representative", "unable_to_sign"] as const).map((value) => ({
              value,
              label: t("people.exit.returns.signerOption", { value }),
            }))}
          />
          {signer === "unable_to_sign" ? (
            <TextField
              id={ids.unableReason}
              name="unableReason"
              label={t("people.exit.returns.unableReason")}
              maxLength={500}
              error={errorFor(result, "unableReason")}
            />
          ) : (
            <TextField
              id={ids.signerName}
              name="signerName"
              label={t("people.exit.returns.signerName")}
              maxLength={200}
              error={errorFor(result, "signerName")}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {t("people.exit.returns.submit")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                inline.hide();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            ref={inline.trigger}
            variant="secondary"
            aria-label={t("people.exit.returns.openNamed", { item: description })}
            onClick={inline.show}
          >
            {t("people.exit.returns.open")}
          </Button>
        </div>
      )}
      <Feedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

/** A key returned today, or reported lost today. */
export function KeyReturn({
  personId,
  path,
  keyId,
  label,
  version,
}: {
  readonly personId: string;
  readonly path: string;
  readonly keyId: string;
  readonly label: string;
  readonly version: number;
}) {
  const { result, pending, send } = useExitSend(path);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={pending}
          aria-label={t("people.exit.returns.keyReturnedNamed", { key: label })}
          onClick={() =>
            send("returned", () => closeKey(personId, keyId, { outcome: "returned", version }))
          }
        >
          {t("people.exit.returns.keyReturned")}
        </Button>
        <Button
          variant="tertiary"
          disabled={pending}
          aria-label={t("people.exit.returns.keyLostNamed", { key: label })}
          onClick={() =>
            send("returned", () => closeKey(personId, keyId, { outcome: "lost", version }))
          }
        >
          {t("people.exit.returns.keyLost")}
        </Button>
      </div>
      <Feedback result={result} path={path} />
    </div>
  );
}
