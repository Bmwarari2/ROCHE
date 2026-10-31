"use client";

import { Button, Checkbox, DateInput, SelectField, TextArea, TextField } from "@harbour/ui";
import { CalendarCheck, FilePlus, Lock, MessageSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { closeComplaint, recordComplaint, recordComplaintDate } from "@/app/actions/dp-complaints";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { COMPLAINTS_PAGE } from "@/lib/data-rights";
import {
  COMPLAINANT_KINDS,
  COMPLAINT_ABOUT,
  COMPLAINT_CHANNELS,
  type Complaint,
  complaintPath,
  OUTCOME_MIN,
} from "@/lib/dp-complaints";
import { characterCount, t } from "@/lib/i18n";
import {
  type ActionResult,
  collectedRefusal,
  errorFor,
  type FieldProblem,
  partsFor,
} from "@/lib/outcome";
import { dateBoxesOf, readDateField } from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

const dateLabels = () => ({
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
});

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Sends an action and, once done, opens the complaint again saying what was done (a new `at`). */
function useComplaintSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (done: string, call: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) router.replace(`${path}?done=${done}&at=${Date.now()}`, { scroll: false });
    });
  return { result, setResult, pending, send };
}

const RECORD_FIELDS = [
  "receivedOn",
  "channel",
  "complainantKind",
  "complainantName",
  "complainantContact",
  "about",
  "summary",
] as const;

const oneOf = <T extends string>(values: readonly T[], value: string): T | null =>
  (values as readonly string[]).includes(value) ? (value as T) : null;

/** Records a data protection complaint received by any channel (rule 25). */
export function RecordComplaintForm() {
  const router = useRouter();
  const ids = useFieldIds(RECORD_FIELDS);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const received = readDateField(form, "receivedOn", {
      subject: t("dataRights.complaint.record.receivedSubject"),
      t,
    });
    if (!received.ok) {
      problems.push({ field: "receivedOn", message: received.message, parts: received.parts });
    }
    const channel = oneOf(COMPLAINT_CHANNELS, text(form, "channel"));
    if (!channel) {
      problems.push({
        field: "channel",
        message: t("dataRights.complaint.record.channelRequired"),
      });
    }
    const kind = oneOf(COMPLAINANT_KINDS, text(form, "complainantKind"));
    if (!kind) {
      problems.push({
        field: "complainantKind",
        message: t("dataRights.complaint.record.kindRequired"),
      });
    }
    const name = text(form, "complainantName");
    if (name.length === 0 || name.length > 200) {
      problems.push({
        field: "complainantName",
        message: t("dataRights.complaint.record.nameRequired"),
      });
    }
    const contact = text(form, "complainantContact");
    if (contact.length > 500) {
      problems.push({
        field: "complainantContact",
        message: t("dataRights.complaint.record.contactTooLong"),
      });
    }
    const about = oneOf(COMPLAINT_ABOUT, text(form, "about"));
    if (!about) {
      problems.push({ field: "about", message: t("dataRights.complaint.record.aboutRequired") });
    }
    const summary = text(form, "summary");
    if (summary.length < 10 || summary.length > 4000) {
      problems.push({
        field: "summary",
        message: t("dataRights.complaint.record.summaryRequired"),
      });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !received.ok || !received.date || !channel || !kind || !about) {
      setResult(refusal);
      return;
    }
    const input = {
      receivedOn: received.date,
      channel,
      complainantKind: kind,
      complainantName: name,
      complainantContact: contact.length > 0 ? contact : null,
      about,
      summary,
    };
    startTransition(async () => {
      const outcome = await recordComplaint(input);
      setResult(outcome);
      if (outcome.ok && outcome.data) {
        router.push(`${complaintPath(outcome.data.id)}?done=recorded&at=${Date.now()}`);
      }
    });
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateInput
        id={ids.receivedOn}
        name="receivedOn"
        legend={t("dataRights.complaint.record.received")}
        hint={t("care.date.hint")}
        labels={dateLabels()}
        error={errorFor(result, "receivedOn")}
        errorParts={dateBoxesOf(partsFor(result, "receivedOn"))}
      />
      <SelectField
        id={ids.channel}
        name="channel"
        label={t("dataRights.complaint.record.channel")}
        emptyOption={t("dataRights.complaint.record.choose")}
        options={COMPLAINT_CHANNELS.map((value) => ({
          value,
          label: t("dataRights.complaint.channel", { channel: value }),
        }))}
        error={errorFor(result, "channel")}
      />
      <SelectField
        id={ids.complainantKind}
        name="complainantKind"
        label={t("dataRights.complaint.record.kind")}
        emptyOption={t("dataRights.complaint.record.choose")}
        options={COMPLAINANT_KINDS.map((value) => ({
          value,
          label: t("dataRights.complaint.kind", { kind: value }),
        }))}
        error={errorFor(result, "complainantKind")}
      />
      <TextField
        id={ids.complainantName}
        name="complainantName"
        label={t("dataRights.complaint.record.name")}
        maxLength={200}
        autoComplete="off"
        error={errorFor(result, "complainantName")}
      />
      <TextField
        id={ids.complainantContact}
        name="complainantContact"
        label={t("dataRights.complaint.record.contact")}
        hint={t("dataRights.complaint.record.contactHint")}
        maxLength={500}
        autoComplete="off"
        error={errorFor(result, "complainantContact")}
      />
      <SelectField
        id={ids.about}
        name="about"
        label={t("dataRights.complaint.record.about")}
        emptyOption={t("dataRights.complaint.record.choose")}
        options={COMPLAINT_ABOUT.map((value) => ({
          value,
          label: t("dataRights.complaint.about", { about: value }),
        }))}
        error={errorFor(result, "about")}
      />
      <TextArea
        id={ids.summary}
        name="summary"
        label={t("dataRights.complaint.record.summary")}
        hint={t("dataRights.complaint.record.summaryHint")}
        rows={4}
        maxLength={4000}
        required
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "summary")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<FilePlus {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.complaint.record.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={COMPLAINTS_PAGE} fieldIds={ids} />
    </form>
  );
}

const DATE_FIELDS = ["on"] as const;

/** Records the day the complaint was acknowledged, or a day the complainant was updated. */
export function ComplaintDateForm({
  id,
  version,
  which,
}: {
  readonly id: string;
  readonly version: number;
  readonly which: "acknowledge" | "contact";
}) {
  const path = complaintPath(id);
  const ids = useFieldIds(DATE_FIELDS);
  const { result, setResult, pending, send } = useComplaintSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const day = readDateField(new FormData(event.currentTarget), "on", {
      subject: t("dataRights.complaint.date.subject", { which }),
      t,
    });
    if (!day.ok || !day.date) {
      setResult(
        day.ok ? null : collectedRefusal([{ field: "on", message: day.message, parts: day.parts }]),
      );
      return;
    }
    const on = day.date;
    send(which === "acknowledge" ? "acknowledged" : "contacted", () =>
      recordComplaintDate(id, which, { expectedVersion: version, on }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateInput
        id={ids.on}
        name="on"
        legend={t("dataRights.complaint.date.legend", { which })}
        hint={t("care.date.hint")}
        labels={dateLabels()}
        error={errorFor(result, "on")}
        errorParts={dateBoxesOf(partsFor(result, "on"))}
      />
      <div>
        <Button
          type="submit"
          variant={which === "contact" ? "secondary" : "primary"}
          disabled={pending}
          icon={which === "acknowledge" ? <CalendarCheck {...icon} /> : <MessageSquare {...icon} />}
        >
          {pending ? t("common.saving") : t("dataRights.complaint.date.submit", { which })}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

const CLOSE_FIELDS = ["closedOn", "outcome", "icoRightStated"] as const;

/**
 * Closes the complaint (rule 25, checkComplaintClosure): the day, the outcome, and confirmation
 * that the outcome told the complainant they can complain to the ICO.
 */
export function CloseComplaintForm({
  id,
  version,
}: {
  readonly id: string;
  readonly version: Complaint["version"];
}) {
  const path = complaintPath(id);
  const ids = useFieldIds(CLOSE_FIELDS);
  const { result, setResult, pending, send } = useComplaintSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const closed = readDateField(form, "closedOn", {
      subject: t("dataRights.complaint.close.daySubject"),
      t,
    });
    if (!closed.ok) {
      problems.push({ field: "closedOn", message: closed.message, parts: closed.parts });
    }
    const outcome = text(form, "outcome");
    if (outcome.length < OUTCOME_MIN || outcome.length > 10_000) {
      problems.push({
        field: "outcome",
        message: t("dataRights.complaint.close.outcomeRequired", { min: OUTCOME_MIN }),
      });
    }
    const icoRightStated = form.get("icoRightStated") === "on";
    if (!icoRightStated) {
      problems.push({
        field: "icoRightStated",
        message: t("dataRights.refusal", { code: "ico_right_required" }),
      });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !closed.ok || !closed.date) {
      setResult(refusal);
      return;
    }
    const closedOn = closed.date;
    send("closed", () =>
      closeComplaint(id, { expectedVersion: version, closedOn, outcome, icoRightStated }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateInput
        id={ids.closedOn}
        name="closedOn"
        legend={t("dataRights.complaint.close.day")}
        hint={t("care.date.hint")}
        labels={dateLabels()}
        error={errorFor(result, "closedOn")}
        errorParts={dateBoxesOf(partsFor(result, "closedOn"))}
      />
      <TextArea
        id={ids.outcome}
        name="outcome"
        label={t("dataRights.complaint.close.outcome")}
        hint={t("dataRights.complaint.close.outcomeHint", { min: OUTCOME_MIN })}
        rows={5}
        maxLength={10_000}
        required
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "outcome")}
      />
      <Checkbox
        id={ids.icoRightStated}
        name="icoRightStated"
        label={t("dataRights.complaint.close.icoRight")}
        error={errorFor(result, "icoRightStated")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Lock {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.complaint.close.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}
