"use client";

import {
  Button,
  Checkbox,
  DateInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { FileSearch, PauseCircle, PlayCircle, Save, Send, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import {
  assessErasure,
  collectRecords,
  confirmIdentity,
  decideRecord,
  endPause,
  extendDeadline,
  type NewRequestInput,
  recordRequest,
  recordResponse,
  startPause,
} from "@/app/actions/dsar";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { REQUESTS_PAGE } from "@/lib/data-rights";
import { partName, requestPage } from "@/lib/dsar";
import { characterCount, t } from "@/lib/i18n";
import {
  type ActionResult,
  collectedRefusal,
  errorFor,
  type FieldProblem,
  partsFor,
} from "@/lib/outcome";
import { dateBoxesOf, readDateField, ukToday } from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const dateLabels = () => ({
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
});

/** Sends an action and, once done, opens `path` saying what was done (a new `at` each time). */
function useSend() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = <T,>(
    path: string,
    done: string,
    call: () => Promise<ActionResult<T>>,
    target?: (data: T) => string,
  ) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        const to = target ? target(outcome.data) : path;
        router.replace(`${to}?done=${done}&at=${Date.now()}`, { scroll: false });
      }
    });
  return { result, setResult, pending, send };
}

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

/** Reads a required date box group, adding its problem to `problems`. */
function dateOf(form: FormData, name: string, subject: string, problems: FieldProblem[]) {
  const read = readDateField(form, name, { subject, t });
  if (!read.ok) {
    problems.push({ field: name, message: read.message, parts: read.parts });
    return null;
  }
  return read.date;
}

function DateField({
  id,
  name,
  legend,
  result,
}: {
  readonly id: string;
  readonly name: string;
  readonly legend: string;
  readonly result: ActionResult<unknown> | null;
}) {
  return (
    <DateInput
      id={id}
      name={name}
      legend={legend}
      hint={t("care.date.hint")}
      defaultValue={ukToday()}
      error={errorFor(result, name)}
      errorParts={dateBoxesOf(partsFor(result, name))}
      labels={dateLabels()}
    />
  );
}

const REQUEST_KINDS = ["access", "rectification", "erasure", "portability"] as const;
const AUTHORITIES = [
  "lpa_health_welfare",
  "lpa_property_finance",
  "deputy",
  "written_authority",
  "other",
] as const;
const CHANNELS = ["email", "post", "phone", "in_person", "portal"] as const;
const NEW_FIELDS = ["subject", "requesterName", "authority", "receivedOn"] as const;

/**
 * Records a request on the day it arrives (rule 2): what is asked, whose information, who is
 * asking and with what authority, how and when it came, and whether identity must be confirmed.
 */
export function NewRequestForm({
  people,
  staff,
}: {
  readonly people: readonly { readonly id: string; readonly name: string }[];
  readonly staff: readonly { readonly id: string; readonly name: string }[];
}) {
  const ids = useFieldIds(NEW_FIELDS);
  const { result, setResult, pending, send } = useSend();
  const [subjectKind, setSubjectKind] = useState<"person" | "staff">("person");
  const [requester, setRequester] = useState<"subject" | "representative">("subject");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const subjectId = text(form, "subject");
    if (!subjectId) problems.push({ field: "subject", message: t("dataRights.new.chooseSubject") });
    const representative = requester === "representative";
    const requesterName = representative ? text(form, "requesterName") : "";
    if (representative && !requesterName)
      problems.push({ field: "requesterName", message: t("dataRights.new.nameRequired") });
    const authority = representative ? text(form, "authority") : "";
    if (representative && !(AUTHORITIES as readonly string[]).includes(authority))
      problems.push({ field: "authority", message: t("dataRights.new.authorityRequired") });
    const receivedOn = dateOf(form, "receivedOn", t("dataRights.new.receivedSubject"), problems);
    const refusal = collectedRefusal(problems);
    if (refusal || receivedOn === null) {
      setResult(refusal);
      return;
    }
    const address = representative ? text(form, "requesterAddress") : "";
    const input: NewRequestInput = {
      requestKind: text(form, "requestKind") as NewRequestInput["requestKind"],
      subjectKind,
      subjectId,
      requesterKind: requester,
      requesterName: representative ? requesterName : null,
      requesterAddress: address || null,
      authority: representative ? (authority as NewRequestInput["authority"]) : null,
      channel: text(form, "channel") as NewRequestInput["channel"],
      receivedOn,
      identityRequired: form.get("identityRequired") === "on",
    };
    send(
      REQUESTS_PAGE,
      "created",
      () => recordRequest(input),
      (data) => requestPage(data.id),
    );
  };
  const subjects = subjectKind === "person" ? people : staff;
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("dataRights.new.intro")}</p>
      <SelectField
        name="requestKind"
        label={t("dataRights.new.kind")}
        defaultValue="access"
        options={REQUEST_KINDS.map((kind) => ({
          value: kind,
          label: t("dataRights.request.kind", { kind }),
        }))}
      />
      <RadioGroup
        name="subjectKind"
        legend={t("dataRights.new.subjectKind")}
        hint={t("dataRights.new.contactHint")}
        value={subjectKind}
        onValueChange={(value) => setSubjectKind(value)}
        options={(["person", "staff"] as const).map((value) => ({
          value,
          label: t(value === "person" ? "dataRights.new.person" : "dataRights.new.staff"),
        }))}
      />
      <SelectField
        key={subjectKind}
        id={ids.subject}
        name="subject"
        label={t(subjectKind === "person" ? "dataRights.new.person" : "dataRights.new.staff")}
        emptyOption={t("dataRights.new.choose")}
        required
        options={subjects.map((s) => ({ value: s.id, label: s.name }))}
        error={errorFor(result, "subject")}
      />
      <RadioGroup
        name="requesterKind"
        legend={t("dataRights.new.requesterKind")}
        value={requester}
        onValueChange={(value) => setRequester(value)}
        options={(["subject", "representative"] as const).map((kind) => ({
          value: kind,
          label: t("dataRights.new.requester", { kind }),
        }))}
      />
      {requester === "representative" ? (
        <>
          <TextField
            id={ids.requesterName}
            name="requesterName"
            label={t("dataRights.new.requesterName")}
            maxLength={200}
            autoComplete="off"
            required
            error={errorFor(result, "requesterName")}
          />
          <TextArea
            name="requesterAddress"
            label={t("dataRights.new.requesterAddress")}
            rows={2}
            maxLength={1000}
            formatCount={(remaining) => characterCount(remaining)}
          />
          <SelectField
            id={ids.authority}
            name="authority"
            label={t("dataRights.new.authority")}
            emptyOption={t("dataRights.new.chooseAuthority")}
            required
            options={AUTHORITIES.map((authority) => ({
              value: authority,
              label: t("dataRights.new.authorityOption", { authority }),
            }))}
            error={errorFor(result, "authority")}
          />
        </>
      ) : null}
      <SelectField
        name="channel"
        label={t("dataRights.new.channel")}
        defaultValue="email"
        options={CHANNELS.map((channel) => ({
          value: channel,
          label: t("dataRights.new.channelOption", { channel }),
        }))}
      />
      <DateField
        id={ids.receivedOn}
        name="receivedOn"
        legend={t("dataRights.new.receivedOn")}
        result={result}
      />
      <Checkbox
        name="identityRequired"
        label={t("dataRights.new.identityRequired")}
        hint={t("dataRights.new.identityHint")}
        defaultChecked
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Save {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.new.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={REQUESTS_PAGE} fieldIds={ids} />
    </form>
  );
}

const METHODS = ["document_seen", "known_to_staff", "authority_checked", "portal_account"] as const;

/** Confirms who is asking; the clock starts that day (rule 2). */
export function IdentityForm({ id, version }: { readonly id: string; readonly version: number }) {
  const ids = useFieldIds(["method", "verifiedOn"]);
  const { result, setResult, pending, send } = useSend();
  const path = requestPage(id);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const method = text(form, "method");
    if (!(METHODS as readonly string[]).includes(method))
      problems.push({ field: "method", message: t("dataRights.identity.methodRequired") });
    const verifiedOn = dateOf(form, "verifiedOn", t("dataRights.identity.onSubject"), problems);
    const refusal = collectedRefusal(problems);
    if (refusal || verifiedOn === null) {
      setResult(refusal);
      return;
    }
    send(path, "identity", () =>
      confirmIdentity(id, {
        verifiedOn,
        method: method as (typeof METHODS)[number],
        expectedVersion: version,
      }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.method}
        name="method"
        label={t("dataRights.identity.methodLabel")}
        emptyOption={t("dataRights.identity.chooseMethod")}
        required
        options={METHODS.map((method) => ({
          value: method,
          label: t("dataRights.identity.method", { method }),
        }))}
        error={errorFor(result, "method")}
      />
      <DateField
        id={ids.verifiedOn}
        name="verifiedOn"
        legend={t("dataRights.identity.on")}
        result={result}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<ShieldCheck {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.identity.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

/** Starts a pause while clarification is awaited, or ends the open one (one at a time). */
export function PauseForm({
  id,
  version,
  paused,
}: {
  readonly id: string;
  readonly version: number;
  readonly paused: boolean;
}) {
  const field = paused ? "to" : "from";
  const ids = useFieldIds([field]);
  const { result, setResult, pending, send } = useSend();
  const path = requestPage(id);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const subject = t(paused ? "dataRights.pause.toSubject" : "dataRights.pause.fromSubject");
    const day = dateOf(form, field, subject, problems);
    const refusal = collectedRefusal(problems);
    if (refusal || day === null) {
      setResult(refusal);
      return;
    }
    send(path, paused ? "resumed" : "paused", () =>
      paused
        ? endPause(id, { to: day, expectedVersion: version })
        : startPause(id, { from: day, expectedVersion: version }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateField
        id={ids[field]}
        name={field}
        legend={t(paused ? "dataRights.pause.to" : "dataRights.pause.from")}
        result={result}
      />
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={pending}
          icon={paused ? <PlayCircle {...icon} /> : <PauseCircle {...icon} />}
        >
          {pending
            ? t("common.saving")
            : t(paused ? "dataRights.pause.end" : "dataRights.pause.start")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

/** Extends the deadline for a complex request or several from the same person (Art 12(3)). */
export function ExtensionForm({ id, version }: { readonly id: string; readonly version: number }) {
  const ids = useFieldIds(["months", "grounds", "reason", "decidedOn"]);
  const { result, setResult, pending, send } = useSend();
  const path = requestPage(id);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const monthsText = text(form, "months");
    const months = /^\d{1,2}$/.test(monthsText) ? Number(monthsText) : 0;
    if (months < 1)
      problems.push({ field: "months", message: t("dataRights.extension.monthsRequired") });
    const grounds = text(form, "grounds");
    if (grounds !== "complex" && grounds !== "multiple_requests")
      problems.push({ field: "grounds", message: t("dataRights.extension.groundsRequired") });
    const reason = text(form, "reason");
    if (!reason)
      problems.push({ field: "reason", message: t("dataRights.extension.reasonRequired") });
    const decidedOn = dateOf(form, "decidedOn", t("dataRights.extension.onSubject"), problems);
    const refusal = collectedRefusal(problems);
    if (refusal || decidedOn === null) {
      setResult(refusal);
      return;
    }
    send(path, "extended", () =>
      extendDeadline(id, {
        months,
        grounds: grounds as "complex" | "multiple_requests",
        reason,
        decidedOn,
        expectedVersion: version,
      }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.months}
        name="months"
        label={t("dataRights.extension.months")}
        inputMode="numeric"
        maxLength={2}
        className="max-w-[8rem]"
        autoComplete="off"
        error={errorFor(result, "months")}
      />
      <SelectField
        id={ids.grounds}
        name="grounds"
        label={t("dataRights.extension.grounds")}
        emptyOption={t("dataRights.extension.chooseGrounds")}
        options={(["complex", "multiple_requests"] as const).map((grounds) => ({
          value: grounds,
          label: t("dataRights.extension.groundsOption", { grounds }),
        }))}
        error={errorFor(result, "grounds")}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("dataRights.extension.reason")}
        hint={t("dataRights.extension.reasonHint")}
        rows={3}
        maxLength={2000}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <DateField
        id={ids.decidedOn}
        name="decidedOn"
        legend={t("dataRights.extension.on")}
        result={result}
      />
      <div>
        <Button type="submit" variant="secondary" disabled={pending} icon={<Save {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.extension.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

/** Finds the subject's records across every module (rule 3); again, only new ones. */
export function CollectForm({ id, again }: { readonly id: string; readonly again: boolean }) {
  const { result, pending, send } = useSend();
  const path = requestPage(id);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send(path, "collected", () => collectRecords(id));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div>
        <Button type="submit" disabled={pending} icon={<FileSearch {...icon} />}>
          {pending
            ? t("common.saving")
            : t(again ? "dataRights.collect.again" : "dataRights.collect.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} />
    </form>
  );
}

/**
 * A person's decision on one record (rule 4): send it, send it with named parts taken out, or
 * hold it back, with a reason for either of the last two. The record's fingerprint as opened goes
 * with it, so a record that changed since is refused rather than decided unseen.
 */
export function DecisionForm({
  caseId,
  itemId,
  version,
  sha256,
  fields,
  current,
  path,
}: {
  readonly caseId: string;
  readonly itemId: string;
  readonly version: number;
  readonly sha256: string;
  readonly fields: readonly string[];
  readonly current: {
    readonly decision: string;
    readonly redactedFields: readonly string[];
    readonly reason: string | null;
  };
  /** This page, to come back to after signing in again. */
  readonly path: string;
}) {
  const ids = useFieldIds(["decision", "redactedFields", "reason"]);
  const { result, setResult, pending, send } = useSend();
  const [decision, setDecision] = useState<"disclose" | "redact" | "withhold" | null>(
    current.decision === "pending"
      ? null
      : (current.decision as "disclose" | "redact" | "withhold"),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    if (decision === null)
      problems.push({ field: "decision", message: t("dataRights.item.decisionRequired") });
    const redacted = decision === "redact" ? form.getAll("redactedFields").map(String) : [];
    if (decision === "redact" && redacted.length === 0)
      problems.push({ field: "redactedFields", message: t("dataRights.item.fieldsRequired") });
    const reason = text(form, "reason");
    if ((decision === "redact" || decision === "withhold") && !reason)
      problems.push({ field: "reason", message: t("dataRights.item.reasonRequired") });
    const refusal = collectedRefusal(problems);
    if (refusal || decision === null) {
      setResult(refusal);
      return;
    }
    send(requestPage(caseId), "decided", () =>
      decideRecord(caseId, itemId, {
        decision,
        redactedFields: redacted,
        reason: reason || null,
        contentSha256: sha256,
        expectedVersion: version,
      }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.decision}
        name="decision"
        legend={t("dataRights.item.decision")}
        required
        value={decision}
        onValueChange={(value) => setDecision(value)}
        options={(["disclose", "redact", "withhold"] as const).map((value) => ({
          value,
          label: t("dataRights.item.decisionOption", { decision: value }),
        }))}
        error={errorFor(result, "decision")}
      />
      {decision === "redact" ? (
        <fieldset
          id={ids.redactedFields}
          className="m-0 flex flex-col gap-2 border-0 p-0"
          aria-describedby={[
            `${ids.redactedFields}-hint`,
            errorFor(result, "redactedFields") ? `${ids.redactedFields}-error` : null,
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <legend className="font-semibold">{t("dataRights.item.fieldsToRedact")}</legend>
          <p id={`${ids.redactedFields}-hint`} className="hb-field__hint m-0">
            {t("dataRights.item.fieldsHint")}
          </p>
          {errorFor(result, "redactedFields") ? (
            <p id={`${ids.redactedFields}-error`} className="hb-field__error m-0">
              {errorFor(result, "redactedFields")}
            </p>
          ) : null}
          {fields.map((field) => (
            <Checkbox
              key={field}
              name="redactedFields"
              value={field}
              label={partName(field)}
              defaultChecked={current.redactedFields.includes(field)}
            />
          ))}
        </fieldset>
      ) : null}
      {decision === "redact" || decision === "withhold" ? (
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("dataRights.item.reason")}
          hint={t("dataRights.item.reasonHint")}
          rows={3}
          maxLength={2000}
          defaultValue={current.reason ?? ""}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "reason")}
        />
      ) : null}
      <div>
        <Button type="submit" disabled={pending} icon={<Save {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.item.submit")}
        </Button>
      </div>
      <ManageFeedback
        result={result}
        path={path}
        fieldIds={ids}
        stepUp={t("dataRights.bundle.stepUp")}
      />
    </form>
  );
}

const OUTCOMES = ["fulfilled", "partly_fulfilled", "refused", "withdrawn"] as const;

/** Records the response and closes the request (rule 5); needs a fresh step-up. */
export function RespondForm({ id, version }: { readonly id: string; readonly version: number }) {
  const ids = useFieldIds(["outcome", "outcomeReason", "respondedOn"]);
  const { result, setResult, pending, send } = useSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const outcome = text(form, "outcome");
    if (!(OUTCOMES as readonly string[]).includes(outcome))
      problems.push({ field: "outcome", message: t("dataRights.bundle.outcomeRequired") });
    const outcomeReason = text(form, "outcomeReason");
    if ((outcome === "partly_fulfilled" || outcome === "refused") && !outcomeReason)
      problems.push({ field: "outcomeReason", message: t("dataRights.bundle.reasonRequired") });
    const respondedOn = dateOf(
      form,
      "respondedOn",
      t("dataRights.bundle.respondedOnSubject"),
      problems,
    );
    const refusal = collectedRefusal(problems);
    if (refusal || respondedOn === null) {
      setResult(refusal);
      return;
    }
    send(requestPage(id), "responded", () =>
      recordResponse(id, {
        respondedOn,
        outcome: outcome as (typeof OUTCOMES)[number],
        outcomeReason: outcomeReason || null,
        expectedVersion: version,
      }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("dataRights.bundle.respondIntro")}</p>
      <SelectField
        id={ids.outcome}
        name="outcome"
        label={t("dataRights.bundle.outcome")}
        emptyOption={t("dataRights.bundle.chooseOutcome")}
        required
        options={OUTCOMES.map((outcome) => ({
          value: outcome,
          label: t("dataRights.bundle.outcomeOption", { outcome }),
        }))}
        error={errorFor(result, "outcome")}
      />
      <TextArea
        id={ids.outcomeReason}
        name="outcomeReason"
        label={t("dataRights.bundle.outcomeReason")}
        hint={t("dataRights.bundle.outcomeReasonHint")}
        rows={3}
        maxLength={2000}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "outcomeReason")}
      />
      <DateField
        id={ids.respondedOn}
        name="respondedOn"
        legend={t("dataRights.bundle.respondedOn")}
        result={result}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Send {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.bundle.submit")}
        </Button>
      </div>
      <ManageFeedback
        result={result}
        path={`/data-rights/requests/${id}/bundle`}
        fieldIds={ids}
        stepUp={t("dataRights.bundle.stepUp")}
      />
    </form>
  );
}

/** Checks the collected records against retention and records it (rule 6); deletes nothing. */
export function ErasureForm({ id, version }: { readonly id: string; readonly version: number }) {
  const { result, pending, send } = useSend();
  const path = requestPage(id);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send(path, "erasure", () => assessErasure(id, version));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={pending}
          icon={<FileSearch {...icon} />}
        >
          {pending ? t("common.saving") : t("dataRights.erasure.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} />
    </form>
  );
}
