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
  linkStopsAt,
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
  const heading = useRef<HTMLHeadingElement>(null);
  // Choosing a person moves focus here, so the records to tick are what is read next (2.4.3).
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="add-title"
      >
        <h3 id="add-title" ref={heading} tabIndex={-1} className="m-0 text-body font-semibold">
          {t("quality.records.formTitle")}
        </h3>
        <TickGroup
          id={ids.records}
          name="records"
          legend={t("quality.records.legend")}
          hint={t("quality.records.hint", { count: candidates.length })}
          options={available.map((c) => ({
            id: c.key,
            // The time is in the name: several records can share a title.
            label: t("quality.records.choice", { title: c.title, when: c.when }),
          }))}
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
 * Redact one withheld free-text field by hand (rules 3 and 4): the original, where the web can
 * read it, shown read-only beside an empty box, so nothing is saved unredacted by one click. A copy
 * identical to the original is refused here; the API refuses a copy that still names someone it
 * should not or holds a long run of digits, and records the redactor as a contributor.
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
  /** The text as the redactor can already read it; empty when the web cannot fetch it. */
  readonly original: string;
  readonly version: number;
  readonly path: string;
}) {
  const ids = useFieldIds(["text"]);
  const introId = `${ids.text}-intro`;
  const { result, pending, send, fail } = useQualitySend(path);
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus the heading, so the instructions are read before the box (2.4.3).
  useEffect(() => heading.current?.focus(), []);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("text");
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > REDACTION_MAX) return fail({ text: t("quality.redact.error") });
    if (original && text === original.trim()) return fail({ text: t("quality.redact.unchanged") });
    send("redacted", () => redactEvidenceField(packId, itemId, fieldKey, { text, version }));
  };
  const error = errorFor(result, "text");
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="redact-title"
      >
        <div className="flex flex-col gap-1">
          <h4 id="redact-title" ref={heading} tabIndex={-1} className="m-0 text-body font-semibold">
            {t("quality.redact.title")} <span lang="en-GB">{label}</span>
          </h4>
          <p id={introId} className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("quality.redact.intro")}
          </p>
        </div>
        {original ? (
          <div className="flex flex-col gap-1">
            <p className="m-0 text-body-dense font-semibold">{t("quality.redact.original")}</p>
            <p className="m-0 whitespace-pre-line rounded-input bg-bg-secondary p-3">{original}</p>
          </div>
        ) : null}
        <TextArea
          id={ids.text}
          name="text"
          label={t("quality.redact.label")}
          hint={t("quality.redact.hint", { known: original ? "true" : "false" })}
          aria-describedby={introId}
          rows={6}
          required
          maxLength={REDACTION_MAX}
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

/**
 * The link, shown once: copy it, send it to the recipient, and the code goes separately. A named
 * region whose heading takes focus when it appears.
 */
function IssuedLink({
  mode,
  issued,
  recipientEmail,
  origin,
  onDone,
}: {
  readonly mode: "release" | "reissue";
  readonly issued: LinkIssued;
  readonly recipientEmail: string;
  readonly origin: string;
  /** The releaser has the link: forget it and say what was done. */
  readonly onDone: () => void;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState<{ ok: boolean; at: number } | null>(null);
  useEffect(() => ref.current?.focus(), []);
  const url = evidenceLinkUrl(origin, issued.token);
  const until = formatDateTime(issued.expiresAt) ?? "";
  const copy = () => {
    const done = (ok: boolean) => setCopied({ ok, at: Date.now() });
    if (!navigator.clipboard) return done(false);
    navigator.clipboard.writeText(url).then(
      () => done(true),
      () => done(false),
    );
  };
  return (
    <section
      aria-labelledby="issued-title"
      className="flex flex-col gap-3 rounded-input border-s-4 border-accent bg-bg-secondary p-4"
    >
      <h2
        id="issued-title"
        ref={ref}
        tabIndex={-1}
        className="m-0 inline-flex items-center gap-2 text-heading-3 font-semibold"
      >
        <Link2 size={18} strokeWidth={1.5} aria-hidden="true" />
        {t("quality.link.issuedTitle", { mode })}
      </h2>
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
        <Button type="button" variant="secondary" onClick={copy}>
          <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
          {t("quality.link.copy")}
        </Button>
        <Button type="button" onClick={onDone}>
          {t("quality.link.done")}
        </Button>
      </div>
      <p role="status" className="m-0 text-body-dense">
        {copied ? (
          <span key={copied.at}>{t("quality.link.copied", { ok: String(copied.ok) })}</span>
        ) : null}
      </p>
    </section>
  );
}

/**
 * Release a draft (or issue a new link for a released pack) with its link (rules 6, 7 and 9):
 * how long the link works, the expiry in words before sending, and a confirmation that the
 * releaser has read every record and redaction. Step-up is the API's to ask for. The link is shown
 * once, here, kept only in this component's state, and forgotten when the releaser says they have
 * sent it; the page then opens again saying what was done. It stays mounted across the refresh the
 * release causes (the page always renders it), so the link is not lost when the pack becomes
 * released.
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
  const [issued, setIssued] = useState<{ link: LinkIssued; mode: "release" | "reissue" } | null>(
    null,
  );
  const [days, setDays] = useState<number | null>(defaultDays);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  if (issued) {
    const done = () => {
      // The token is dropped from memory here; it was never stored or put in a URL.
      setIssued(null);
      setResult(null);
      router.replace(
        `${path}?done=${issued.mode === "release" ? "released" : "reissued"}&at=${Date.now()}`,
      );
    };
    return (
      <IssuedLink
        mode={issued.mode}
        issued={issued.link}
        recipientEmail={recipientEmail}
        origin={origin}
        onDone={done}
      />
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
      if (outcome.ok) setIssued({ link: outcome.data, mode });
    });
  };
  const until =
    days === null ? null : (formatDateTime(linkStopsAt(new Date(), days).toISOString()) ?? null);
  const confirmError = errorFor(result, "confirm");

  return (
    <section aria-labelledby="release-title" className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="release-title"
      >
        <div className="flex flex-col gap-1">
          <h2 id="release-title" className="m-0 text-heading-3 font-semibold">
            {t("quality.release.title", { mode })}
          </h2>
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
    </section>
  );
}
