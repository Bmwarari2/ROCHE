"use client";

import { Button, Checkbox, SelectField, TextArea, TextField } from "@harbour/ui";
import { CircleAlert, Copy, Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import {
  addEvidenceItems,
  type LinkIssued,
  redactEvidenceField,
  reissueEvidenceLink,
  releaseEvidencePack,
} from "@/app/actions/quality";
import { useFieldIds } from "@/components/care/form-state";
import { Notice } from "@/components/care/Notice";
import {
  evidenceLinkUrl,
  KEY_QUESTIONS,
  keyQuestionLabel,
  REDACTION_MAX,
  readRecordChoices,
} from "@/lib/evidence-packs";
import { formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor } from "@/lib/outcome";
import { TickGroup } from "./ComposePackForm";
import { QualityFeedback, useQualitySend } from "./QualityForms";

export interface RecordCandidate {
  readonly key: string;
  readonly title: string;
  readonly when: string;
  readonly inPack: boolean;
}

/**
 * Add one person's records to a draft (`quality.evidence_pack.compose`; rule 2): their care
 * notes, observations and incidents in the pack's dates, ticked, with the key questions they are
 * evidence for. The API keeps or leaves out each record and minimises every field.
 */
export function AddRecordsForm({
  packId,
  version,
  path,
  candidates,
}: {
  readonly packId: string;
  readonly version: number;
  readonly path: string;
  readonly candidates: readonly RecordCandidate[];
}) {
  const ids = useFieldIds(["records", "statementIds"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readRecordChoices(new FormData(event.currentTarget), t);
    if (!read.ok) return fail(read.errors);
    send("added", () => addEvidenceItems(packId, { items: read.items, version }));
  };
  const available = candidates.filter((c) => !c.inPack);
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="add-title"
      >
        <h3 id="add-title" className="m-0 text-body font-semibold">
          {t("quality.records.formTitle")}
        </h3>
        <TickGroup
          id={ids.records}
          name="records"
          legend={t("quality.records.legend")}
          hint={t("quality.records.hint", { count: candidates.length })}
          options={available.map((c) => ({ id: c.key, label: c.title, hint: c.when }))}
          error={errorFor(result, "records")}
        />
        {candidates.some((c) => c.inPack) ? (
          <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-body-dense text-text-secondary">
            {candidates
              .filter((c) => c.inPack)
              .map((c) => (
                <li key={c.key}>
                  {t("quality.records.alreadyIn", { title: c.title, when: c.when })}
                </li>
              ))}
          </ul>
        ) : null}
        <TickGroup
          id={ids.statementIds}
          name="statementIds"
          legend={t("quality.records.statements")}
          hint={t("quality.records.statementsHint")}
          options={KEY_QUESTIONS.map((q) => ({ id: q, label: keyQuestionLabel(q, t) }))}
          error={errorFor(result, "statementIds")}
        />
        <div>
          <Button type="submit" disabled={pending || available.length === 0}>
            {pending ? t("common.saving") : t("quality.records.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

/**
 * Redact one withheld free-text field by hand (rule 3 and 4): edit the original into the words the
 * inspector may read. The API refuses a copy that still names someone it should not, or holds a
 * long run of digits, and records the redactor as a contributor.
 */
export function RedactForm({
  packId,
  itemId,
  fieldKey,
  label,
  original,
  version,
  path,
}: {
  readonly packId: string;
  readonly itemId: string;
  readonly fieldKey: string;
  readonly label: string;
  /** The text as the redactor can already read it, to edit; empty when the web cannot fetch it. */
  readonly original: string;
  readonly version: number;
  readonly path: string;
}) {
  const ids = useFieldIds(["text"]);
  const { result, pending, send, fail } = useQualitySend(path);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("text");
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > REDACTION_MAX) {
      return fail({ text: t("quality.redact.error") });
    }
    send("redacted", () => redactEvidenceField(packId, itemId, fieldKey, { text, version }));
  };
  const error = errorFor(result, "text");
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="redact-title"
      >
        <div className="flex flex-col gap-1">
          <h4 id="redact-title" className="m-0 text-body font-semibold">
            {t("quality.redact.title", { label })}
          </h4>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("quality.redact.intro")}
          </p>
        </div>
        <TextArea
          ref={ref}
          id={ids.text}
          name="text"
          label={t("quality.redact.label")}
          hint={t("quality.redact.hint", { known: original ? "true" : "false" })}
          rows={6}
          required
          maxLength={REDACTION_MAX}
          defaultValue={original}
          formatCount={(remaining) => characterCount(remaining)}
          {...(error ? { error } : {})}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("quality.redact.submit")}
          </Button>
        </div>
      </form>
      <QualityFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

/** The link, shown once: copy it, send it to the recipient, and the code goes separately. */
function IssuedLink({
  issued,
  recipientEmail,
  origin,
  onDone,
}: {
  readonly issued: LinkIssued;
  readonly recipientEmail: string;
  readonly origin: string;
  /** The releaser has the link: forget it, and move focus to the page's heading. */
  readonly onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => ref.current?.focus(), []);
  const url = evidenceLinkUrl(origin, issued.token);
  const until = formatDateTime(issued.expiresAt) ?? "";
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      className="flex flex-col gap-3 rounded-input border-s-4 border-accent bg-bg-secondary p-4"
    >
      <p className="m-0 inline-flex items-center gap-2 font-semibold">
        <Link2 size={18} strokeWidth={1.5} aria-hidden="true" />
        {t("quality.link.issuedTitle")}
      </p>
      <p className="m-0 max-w-prose">
        {t("quality.link.issuedBody", { email: recipientEmail, until })}
      </p>
      <TextField
        label={t("quality.link.field")}
        hint={t("quality.link.fieldHint")}
        value={url}
        readOnly
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
        >
          <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
          {t("quality.link.copy")}
        </Button>
        <Button type="button" onClick={onDone}>
          {t("quality.link.done")}
        </Button>
        <span aria-live="polite" className="text-body-dense">
          {copied ? t("quality.link.copied") : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * Release a draft (or issue a new link for a released pack) with its link (rules 6, 7 and 9):
 * how long the link works, the expiry in words before sending, and a confirmation that the
 * releaser has read every record and redaction. Step-up is the API's to ask for. The link is shown
 * once, here, kept only in this component's state, and the page refreshes when the releaser says
 * they have it. It stays mounted across the refresh (the page always renders it), so the link is
 * not lost when the pack becomes released.
 */
export function LinkIssuer({
  mode,
  packId,
  linkId,
  version,
  path,
  recipientEmail,
  origin,
  choices,
  defaultDays,
}: {
  /** Null when this person may do neither now. */
  readonly mode: "release" | "reissue" | null;
  readonly packId: string;
  readonly linkId: string | null;
  readonly version: number;
  readonly path: string;
  readonly recipientEmail: string;
  readonly origin: string;
  /** Days the link may work; empty when the policy could not be read (the API's default). */
  readonly choices: readonly number[];
  readonly defaultDays: number | null;
}) {
  const ids = useFieldIds(["days", "confirm"]);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [issued, setIssued] = useState<LinkIssued | null>(null);
  const [days, setDays] = useState<number | null>(defaultDays);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  if (issued) {
    const done = () => {
      // The token is dropped from memory here; it was never stored or put in a URL.
      setIssued(null);
      setResult(null);
      router.refresh();
      const heading = document.querySelector("h1");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus();
    };
    return (
      <IssuedLink issued={issued} recipientEmail={recipientEmail} origin={origin} onDone={done} />
    );
  }
  if (!mode) return null;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const confirmed = new FormData(event.currentTarget).get("confirm") === "yes";
    if (!confirmed) {
      setResult({
        ok: false,
        code: "invalid",
        message: t("quality.release.confirmError"),
        fields: { confirm: t("quality.release.confirmError") },
      });
      return;
    }
    startTransition(async () => {
      const outcome =
        mode === "release"
          ? await releaseEvidencePack(packId, { days, version })
          : linkId
            ? await reissueEvidenceLink(packId, linkId, { days, version })
            : null;
      if (!outcome) return;
      setResult(outcome);
      if (outcome.ok) setIssued(outcome.data);
    });
  };
  const until =
    days === null
      ? null
      : (formatDateTime(new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()) ?? null);
  const confirmError = errorFor(result, "confirm");

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="release-title"
      >
        <div className="flex flex-col gap-1">
          <h3 id="release-title" className="m-0 text-body font-semibold">
            {t("quality.release.title", { mode })}
          </h3>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("quality.release.intro", { mode })}
          </p>
        </div>
        {choices.length > 0 ? (
          <SelectField
            id={ids.days}
            name="days"
            label={t("quality.release.days")}
            hint={t("quality.release.daysHint", { max: Math.max(...choices) })}
            value={String(days ?? "")}
            onChange={(event) => setDays(Number(event.currentTarget.value))}
            options={choices.map((d) => ({
              value: String(d),
              label: t("quality.release.dayChoice", {
                days: d,
                isDefault: String(d === defaultDays),
              }),
            }))}
          />
        ) : (
          <p className="m-0">{t("quality.release.defaultExpiry")}</p>
        )}
        {until ? (
          <p className="m-0 font-semibold" aria-live="polite">
            {t("quality.release.until", { until, days: days ?? 0 })}
          </p>
        ) : null}
        <Notice
          tone="warning"
          icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("quality.release.checkTitle")}
        >
          {t("quality.release.checkBody")}
        </Notice>
        <Checkbox
          id={ids.confirm}
          name="confirm"
          value="yes"
          label={t("quality.release.confirm")}
          required
          {...(confirmError ? { error: confirmError } : {})}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("quality.release.submit", { mode })}
          </Button>
        </div>
      </form>
      <QualityFeedback
        result={result}
        path={path}
        fieldIds={ids}
        stepUp={t("quality.release.stepUp")}
      />
    </div>
  );
}
