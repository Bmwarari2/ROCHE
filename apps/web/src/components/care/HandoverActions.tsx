"use client";

import { Button, TextArea } from "@harbour/ui";
import { CheckCheck, MessageSquarePlus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState, useTransition } from "react";
import { acknowledgeHandover, addHandoverNote, compileHandover } from "@/app/actions/handover";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds, useInlineForm } from "./form-state";

/**
 * The shift handover's actions (care.md rule 14): compile it or bring it up to date, add a note
 * to it or to one of its items, and acknowledge it as read. Each says what happened in words that
 * take focus; a refusal is said in the API's words, or the catalogue's when the web knows it.
 */

/** Compile the shift running now, or add what has appeared since; then open it. */
export function CompileHandover({
  locationId,
  label,
}: {
  readonly locationId: string;
  readonly label: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={16} strokeWidth={1.5} />}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const outcome = await compileHandover(locationId);
              setResult(outcome.ok ? null : outcome);
              if (outcome.ok) {
                router.push(`/handover/${locationId}/${outcome.data.id}?done=compiled`);
              }
            })
          }
        >
          {label}
        </Button>
      </div>
      <FormFeedback result={result} success={t("care.handover.compiled")} />
    </div>
  );
}

const NOTE_FIELDS = ["body"] as const;

/** A note on the handover, or on one of its items; a note adds, it never replaces. */
export function HandoverNoteForm({
  locationId,
  handoverId,
  itemKey,
  open,
}: {
  readonly locationId: string;
  readonly handoverId: string;
  /** The item the note is about; null for the whole handover. */
  readonly itemKey: string | null;
  /** The button's words, naming what the note is about. */
  readonly open: string;
}) {
  const router = useRouter();
  const inline = useInlineForm<HTMLTextAreaElement>();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(NOTE_FIELDS);
  const entry = useEntryId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = String(new FormData(event.currentTarget).get("body") ?? "");
    if (!body.trim()) {
      setResult(refused(t("care.handover.noteRequired"), "invalid", ["body"]));
      return;
    }
    startTransition(async () => {
      const outcome = await addHandoverNote(locationId, handoverId, {
        id: entry.id,
        itemKey,
        body,
      });
      setResult(outcome);
      if (outcome.ok) {
        entry.next();
        inline.hide();
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <TextArea
            ref={inline.firstField}
            id={ids.body}
            name="body"
            label={t("care.handover.note")}
            hint={t("care.handover.noteHint")}
            rows={3}
            required
            maxLength={2000}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, "body")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("care.handover.saveNote")}
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
            icon={<MessageSquarePlus size={16} strokeWidth={1.5} />}
            onClick={() => {
              setResult(null);
              inline.show();
            }}
          >
            {open}
          </Button>
        </div>
      )}
      <FormFeedback
        result={result}
        success={t("care.handover.noteSaved")}
        fieldIds={ids}
        focusOnSuccess={inline.trigger}
      />
    </div>
  );
}

/**
 * "I have read this handover": sends the token of the handover as it was shown, so nobody
 * acknowledges items they have not seen; when items were added since, the page reloads with
 * them and says so.
 */
export function AcknowledgeHandover({
  locationId,
  handoverId,
  seenToken,
}: {
  readonly locationId: string;
  readonly handoverId: string;
  readonly seenToken: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const entry = useEntryId();
  // A new token (items added and shown) is a new acknowledgement.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the token alone.
  useEffect(() => entry.next(), [seenToken]);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          icon={<CheckCheck size={16} strokeWidth={1.5} />}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const outcome = await acknowledgeHandover(locationId, handoverId, {
                id: entry.id,
                seenToken,
              });
              setResult(outcome.ok ? null : outcome);
              if (outcome.ok) {
                router.push(`/handover/${locationId}/${handoverId}?done=acknowledged`);
              } else if (outcome.code === "handover_changed") {
                router.refresh();
              }
            })
          }
        >
          {t("care.handover.acknowledge")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("care.handover.acknowledged")} />
    </div>
  );
}
