"use client";

import type { FeedPreview } from "@harbour/contracts";
import { Button, Checkbox, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { Eye, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { type FeedRequest, previewFeedItem, publishFeedItem } from "@/app/actions/family-feed";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { uuidv7 } from "@/lib/entry-id";
import {
  CONFIRMATION_MAX,
  draftProblems,
  FEED_TEXT_MAX,
  type FeedDraft,
  type FeedSourceKind,
  needsConfirmation,
  previewRefusal,
  publishSource,
  type SourceOption,
  STAFF_SHOWN_MAX,
} from "@/lib/family-feed";
import { formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import {
  type ActionResult,
  collectedRefusal,
  errorFor,
  outcomeUnknown,
  refused,
} from "@/lib/outcome";

const EMPTY: Omit<FeedDraft, "kind" | "sourceId"> = {
  text: "",
  caption: "",
  onlyThisPerson: false,
  staffShown: [],
  confirmationReason: "",
};

/**
 * Writing one family update from one of the person's records (comms.md rules 6 to 12; HZ-022,
 * HZ-060, HZ-061). Staff choose the record, write the family's words for a note (the note itself
 * never goes to the family) or a caption for a photo, and preview: the API composes the update and
 * says each problem at its field (another resident named, a clinical word, publishing on hold).
 * Publishing sends exactly what was previewed, with the form's own id, so a retry after a dropped
 * connection never publishes twice. Any change after the preview asks for a new preview.
 */
export function FeedPublisher({
  personId,
  path,
  sources,
  unreadable,
  staff,
}: {
  readonly personId: string;
  readonly path: string;
  readonly sources: Readonly<Record<FeedSourceKind, readonly SourceOption[]>>;
  /** Staff the publisher may name as shown in a photo (H-905); null when the list was unreadable. */
  readonly staff: readonly { readonly id: string; readonly name: string }[] | null;
  /** The kinds of record that could not be read: said so, never "there are none". */
  readonly unreadable: readonly FeedSourceKind[];
}) {
  const router = useRouter();
  const ids = useFieldIds([
    "kind",
    "source",
    "text",
    "caption",
    "onlyThisPerson",
    "staffShown",
    "confirmationReason",
  ]);
  const [kind, setKind] = useState<FeedSourceKind>("shared_note");
  const [sourceId, setSourceId] = useState("");
  const [words, setWords] = useState(EMPTY);
  const [askReason, setAskReason] = useState(false);
  // The request previewed, with its own id: publishing sends exactly this, so the words published
  // are the words checked (HZ-061). Each new preview gets a new id; a retry after an unknown
  // outcome sends the same request and id, so it cannot publish twice.
  const [bound, setBound] = useState<{
    readonly request: FeedRequest;
    readonly preview: FeedPreview;
  } | null>(null);
  const preview = bound?.preview ?? null;
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const previewHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);

  const draft: FeedDraft = { kind, sourceId, ...words };
  const request = (): FeedRequest => ({
    id: uuidv7(),
    source: publishSource(draft),
    ...(askReason && words.confirmationReason.trim()
      ? { confirmationReason: words.confirmationReason.trim() }
      : {}),
  });

  /** Anything typed after a preview makes it out of date: preview again before publishing. */
  const edit = (change: Partial<typeof EMPTY>) => {
    setWords((current) => ({ ...current, ...change }));
    setBound(null);
  };
  const choose = (nextKind: FeedSourceKind, nextSource: string) => {
    setKind(nextKind);
    setSourceId(nextSource);
    setBound(null);
    setResult(null);
    setAskReason(false);
  };

  const onPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = collectedRefusal(
      draftProblems(draft, {
        chooseSource: t("comms.feed.publish.chooseSource", { kind }),
        textRequired: t("comms.feed.publish.textRequired"),
        tooLong: (max) => t("comms.feed.publish.tooLong", { max }),
        staffTooMany: t("comms.feed.publish.staffTooMany", { max: STAFF_SHOWN_MAX }),
      }),
    );
    if (found) {
      setResult(found);
      setBound(null);
      return;
    }
    const sent = request();
    startTransition(async () => {
      const outcome = await previewFeedItem(personId, sent);
      if (!outcome.ok) {
        setResult(outcome);
        setBound(null);
        return;
      }
      if (needsConfirmation(outcome.data)) setAskReason(true);
      setResult(previewRefusal(outcome.data, kind));
      setBound(outcome.data.ok ? { request: sent, preview: outcome.data } : null);
    });
  };

  const onPublish = () => {
    if (!bound) return;
    startTransition(async () => {
      const outcome = await publishFeedItem(personId, bound.request);
      if (outcome.ok && outcome.data.text === bound.preview.text) {
        router.replace(`${path}?done=published&at=${Date.now()}`, { scroll: false });
        return;
      }
      if (outcome.ok) {
        // An update already published with this id carries other words: never say "published".
        setResult(refused(t("comms.feed.publish.textDiffers"), "text_differs"));
        setBound(null);
        router.refresh();
        return;
      }
      setResult(outcome);
      // The outcome is unknown: keep the request and id so publishing again cannot make a second.
      if (!outcomeUnknown(outcome)) setBound(null);
    });
  };

  const options = sources[kind];
  const kindOptions = (["shared_note", "activity", "photo"] as const).map((value) => ({
    value,
    label: t("comms.feed.publish.kind", { kind: value }),
  }));

  return (
    <div className="flex flex-col gap-6">
      <form method="post" className="flex flex-col gap-4" onSubmit={onPreview} noValidate>
        <RadioGroup
          id={ids.kind}
          name="kind"
          legend={t("comms.feed.publish.kindLegend")}
          options={kindOptions}
          value={kind}
          onValueChange={(value) => choose(value, "")}
          layout="inline"
        />
        {unreadable.includes(kind) ? (
          <p className="m-0" id={ids.source}>
            {t("comms.feed.publish.sourcesUnavailable", { kind })}
          </p>
        ) : options.length === 0 ? (
          <p className="m-0" id={ids.source}>
            {t("comms.feed.publish.noSources", { kind })}
          </p>
        ) : (
          <SelectField
            id={ids.source}
            name="source"
            label={t("comms.feed.publish.source", { kind })}
            hint={
              kind === "photo"
                ? t("comms.feed.publish.photoHint")
                : t("comms.feed.publish.sourceHint")
            }
            emptyOption={t("comms.feed.publish.chooseOption")}
            value={sourceId}
            onChange={(event) => choose(kind, event.target.value)}
            error={errorFor(result, "source")}
            options={options.map((option) => ({
              value: option.id,
              label: t("comms.feed.publish.option", {
                label: option.label,
                when: formatDateTime(option.occurredAt) ?? "",
              }),
            }))}
          />
        )}
        {kind === "shared_note" ? (
          <TextArea
            id={ids.text}
            name="text"
            label={t("comms.feed.publish.text")}
            hint={t("comms.feed.publish.textHint")}
            value={words.text}
            onChange={(event) => edit({ text: event.target.value })}
            maxLength={FEED_TEXT_MAX}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, "text")}
          />
        ) : null}
        {kind === "photo" ? (
          <>
            <TextArea
              id={ids.caption}
              name="caption"
              label={t("comms.feed.publish.caption")}
              hint={t("comms.feed.publish.captionHint")}
              value={words.caption}
              onChange={(event) => edit({ caption: event.target.value })}
              maxLength={FEED_TEXT_MAX}
              formatCount={(remaining) => characterCount(remaining)}
              error={errorFor(result, "caption")}
            />
            <Checkbox
              id={ids.onlyThisPerson}
              name="onlyThisPerson"
              label={t("comms.feed.publish.onlyThisPerson")}
              checked={words.onlyThisPerson}
              onChange={(event) => edit({ onlyThisPerson: event.target.checked })}
              error={errorFor(result, "onlyThisPerson")}
            />
            <fieldset
              id={ids.staffShown}
              tabIndex={-1}
              aria-describedby={
                errorFor(result, "staffShown")
                  ? `${ids.staffShown}-hint ${ids.staffShown}-error`
                  : `${ids.staffShown}-hint`
              }
              className={`hb-choice${errorFor(result, "staffShown") ? " hb-choice--invalid" : ""}`}
            >
              <legend className="hb-choice__legend">{t("comms.feed.publish.staffShown")}</legend>
              <p id={`${ids.staffShown}-hint`} className="hb-field__hint">
                {t("comms.feed.publish.staffShownHint")}
              </p>
              {errorFor(result, "staffShown") ? (
                <p id={`${ids.staffShown}-error`} className="hb-field__error">
                  {errorFor(result, "staffShown")}
                </p>
              ) : null}
              {staff === null ? (
                <p className="m-0">{t("comms.feed.publish.staffUnavailable")}</p>
              ) : (
                staff.map((member) => (
                  <Checkbox
                    key={member.id}
                    name="staffShown"
                    value={member.id}
                    label={member.name}
                    checked={words.staffShown.includes(member.id)}
                    onChange={(event) =>
                      edit({
                        staffShown: event.target.checked
                          ? [...words.staffShown, member.id]
                          : words.staffShown.filter((m) => m !== member.id),
                      })
                    }
                  />
                ))
              )}
            </fieldset>
          </>
        ) : null}
        {askReason ? (
          <TextField
            id={ids.confirmationReason}
            name="confirmationReason"
            label={t("comms.feed.publish.confirmationReason")}
            hint={t("comms.feed.publish.confirmationHint")}
            value={words.confirmationReason}
            onChange={(event) => edit({ confirmationReason: event.target.value })}
            maxLength={CONFIRMATION_MAX}
            error={errorFor(result, "confirmationReason")}
          />
        ) : null}
        <div>
          <Button
            type="submit"
            variant={preview ? "secondary" : "primary"}
            icon={<Eye size={20} strokeWidth={1.5} aria-hidden="true" />}
            disabled={pending}
          >
            {t("comms.feed.publish.preview")}
          </Button>
        </div>
        {preview ? null : <ManageFeedback result={result} path={path} fieldIds={ids} />}
      </form>

      {preview ? (
        <section aria-labelledby="feed-preview" className="flex flex-col gap-4">
          <h3
            id="feed-preview"
            ref={previewHeading}
            tabIndex={-1}
            className="m-0 text-body font-semibold"
          >
            {t("comms.feed.publish.previewTitle")}
          </h3>
          <p className="m-0 text-body-dense text-text-secondary">
            {t("comms.feed.publish.previewIntro")}
          </p>
          <blockquote className="m-0 max-w-prose whitespace-pre-wrap break-words rounded-input border border-border p-4">
            {preview.text}
          </blockquote>
          {preview.lint.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="m-0 font-semibold">{t("comms.feed.publish.lintTitle")}</p>
              <ul className="m-0 flex flex-col gap-1 ps-6">
                {preview.lint.map((finding) => (
                  <li key={finding}>{finding}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <Button
              type="button"
              onClick={onPublish}
              icon={<Send size={20} strokeWidth={1.5} aria-hidden="true" />}
              disabled={pending}
            >
              {t("comms.feed.publish.submit")}
            </Button>
          </div>
          <ManageFeedback result={result} path={path} fieldIds={ids} />
        </section>
      ) : null}
    </div>
  );
}
