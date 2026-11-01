"use client";

import type { LoneWorkerOutcome } from "@harbour/contracts";
import { Button, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { CircleAlert, CircleCheck, LifeBuoy, Pause, Play, RefreshCw, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  acknowledgeLoneWorkerAlarm,
  recordLoneWorkerEvent,
  startLoneWorkerSession,
} from "@/app/actions/lone-worker";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useEntryId, useFieldIds } from "@/components/care/form-state";
import { Notice } from "@/components/care/Notice";
import { formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import {
  type Announcement,
  newAnnouncements,
  OUTCOMES,
  RETRY_WINDOW_MS,
  readAcknowledge,
  readStart,
  WORK_KINDS,
} from "@/lib/lone-worker";
import { type ActionResult, collectedRefusal, errorFor, outcomeUnknown } from "@/lib/outcome";
import { isEditing, startEditing, stopEditing, whenIdle } from "@/lib/round-editing";

/**
 * Lone-worker forms (scheduling.md section 14.8a; HZ-125). Every write carries the client's id,
 * kept only for a retry straight after a lost answer, so a retry records once and a later press is
 * never taken for the earlier one. The worker's buttons offer check-in, help and finish only:
 * duress is never offered or named on the web (H-1140).
 */

/**
 * Reads the page again every interval while it is visible and nobody is typing in one of its
 * forms (a re-read could take an alarm off the board with a half-written note), with a pause.
 * Says when the page has not been updated for two intervals, announces new items (a duress or
 * help alarm assertively) and puts the count in the tab's title.
 */
export function AutoRefresh({
  checkedAt,
  intervalSeconds,
  announcements = [],
  staleWords,
  titleCount,
}: {
  readonly checkedAt: string;
  readonly intervalSeconds: number;
  /** What is on the page now; one not there at the last read is announced. */
  readonly announcements?: readonly Announcement[];
  /** What to do while the page is out of date. */
  readonly staleWords: string;
  /** Shown before the tab's title while above zero (open alarms). */
  readonly titleCount?: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const readAgain = useCallback(() => {
    if (isEditing()) return;
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    if (paused) return;
    const tick = () => {
      if (document.visibilityState === "visible") readAgain();
    };
    const timer = window.setInterval(tick, intervalSeconds * 1000);
    document.addEventListener("visibilitychange", tick);
    const stopListening = whenIdle(readAgain);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      stopListening();
    };
  }, [readAgain, intervalSeconds, paused]);

  // A clock for the stale warning, apart from the reads, so a failed read still shows as stale.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const stale = now - Date.parse(checkedAt) > intervalSeconds * 2000;

  const seen = useRef<ReadonlySet<string> | null>(null);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  useEffect(() => {
    const fresh = newAnnouncements(seen.current, announcements);
    seen.current = new Set(announcements.map((a) => a.key));
    if (fresh.length === 0) return;
    const words = fresh.map((a) => a.words).join(" ");
    if (fresh.some((a) => a.urgent)) setAssertive(words);
    else setPolite(words);
  }, [announcements]);

  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    baseTitle.current ??= document.title;
    document.title =
      titleCount && titleCount > 0
        ? t("scheduling.loneWorker.titleCount", { count: titleCount, title: baseTitle.current })
        : baseTitle.current;
  }, [titleCount]);
  useEffect(
    () => () => {
      if (baseTitle.current !== null) document.title = baseTitle.current;
    },
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 text-body-dense text-text-secondary">
          {t("scheduling.loneWorker.updatedAt")}{" "}
          <time dateTime={checkedAt}>{formatDateTime(checkedAt)}</time>.{" "}
          {paused
            ? t("scheduling.loneWorker.paused")
            : t("scheduling.loneWorker.checksEvery", { seconds: intervalSeconds })}
        </p>
        <Button
          variant="secondary"
          icon={<RefreshCw size={16} strokeWidth={1.5} />}
          onClick={() => startTransition(() => router.refresh())}
        >
          {t("scheduling.loneWorker.readAgain")}
        </Button>
        <Button
          variant="secondary"
          icon={
            paused ? <Play size={16} strokeWidth={1.5} /> : <Pause size={16} strokeWidth={1.5} />
          }
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
        >
          {t("scheduling.loneWorker.pause")}
        </Button>
      </div>
      {stale ? (
        <Notice
          tone="warning"
          icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("scheduling.loneWorker.stale", {
            time: formatDateTime(checkedAt) ?? "",
          })}
        >
          <p className="m-0">{staleWords}</p>
        </Notice>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {polite}
      </p>
      <p className="sr-only" aria-live="assertive">
        {assertive}
      </p>
    </div>
  );
}

const START_FIELDS = ["locationId", "workKind", "hours", "minutes", "intervalMinutes"] as const;

/** Start a session: where, what kind of work, how long, and how often to check in. */
export function StartSessionForm({
  locations,
  defaultLocationId,
}: {
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly defaultLocationId: string | null;
}) {
  const router = useRouter();
  const ids = useFieldIds(START_FIELDS);
  const entry = useEntryId();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readStart(new FormData(event.currentTarget), t);
    if (!read.ok) {
      setResult(collectedRefusal(read.problems));
      return;
    }
    startTransition(async () => {
      const outcome = await startLoneWorkerSession({ id: entry.id, ...read.input });
      setResult(outcome);
      if (!outcomeUnknown(outcome)) entry.next();
      // The page that follows says the session started and takes focus there.
      if (outcome.ok) router.push("/lone-working?done=started", { scroll: false });
    });
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.locationId}
        name="locationId"
        label={t("scheduling.loneWorker.start.location")}
        defaultValue={defaultLocationId ?? ""}
        emptyOption={t("scheduling.loneWorker.start.chooseLocation")}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
        error={errorFor(result, "locationId")}
      />
      <RadioGroup
        id={ids.workKind}
        name="workKind"
        legend={t("scheduling.loneWorker.start.kind")}
        options={WORK_KINDS.map((kind) => ({
          value: kind,
          label: t("scheduling.loneWorker.workKind", { kind }),
        }))}
        error={errorFor(result, "workKind")}
      />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 font-semibold">{t("scheduling.loneWorker.start.length")}</legend>
        <p className="m-0 text-body-dense text-text-secondary">
          {t("scheduling.loneWorker.start.lengthHint")}
        </p>
        <div className="flex flex-wrap gap-3">
          <TextField
            id={ids.hours}
            name="hours"
            inputMode="numeric"
            className="w-24"
            label={t("scheduling.loneWorker.start.hours")}
            error={errorFor(result, "hours")}
          />
          <TextField
            id={ids.minutes}
            name="minutes"
            inputMode="numeric"
            className="w-24"
            label={t("scheduling.loneWorker.start.minutes")}
            error={errorFor(result, "minutes")}
          />
        </div>
      </fieldset>
      <TextField
        id={ids.intervalMinutes}
        name="intervalMinutes"
        inputMode="numeric"
        className="w-32"
        label={t("scheduling.loneWorker.start.interval")}
        hint={t("scheduling.loneWorker.start.intervalHint")}
        error={errorFor(result, "intervalMinutes")}
      />
      <div>
        <Button type="submit" icon={<Play size={16} strokeWidth={1.5} />} disabled={pending}>
          {t("scheduling.loneWorker.start.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("scheduling.loneWorker.start.done")}
        fieldIds={ids}
      />
    </form>
  );
}

type WorkerKind = "check_in" | "help" | "finish";

/** A press's id, kept only for a retry soon after an answer was lost. */
interface KeptId {
  readonly id: string;
  readonly at: number;
}

/**
 * The worker's buttons. Check in comes first; asking for help is apart, sends at once, has its own
 * pending state and is never disabled (a second press is safe: the API re-sends at most once a
 * minute); finishing asks first, because a finished session tells nobody if the worker goes quiet.
 */
export function SessionActions({ sessionId }: { readonly sessionId: string }) {
  const router = useRouter();
  const kept = useRef<Partial<Record<WorkerKind, KeptId>>>({});
  const [result, setResult] = useState<ActionResult<{ message: string }> | null>(null);
  const [success, setSuccess] = useState("");
  const [pending, startTransition] = useTransition();
  const [, startHelp] = useTransition();
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const finishTrigger = useRef<HTMLButtonElement>(null);
  const keepGoing = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingFinish) keepGoing.current?.focus();
  }, [confirmingFinish]);

  const idFor = (kind: WorkerKind) => {
    const previous = kept.current[kind];
    const id =
      previous && Date.now() - previous.at < RETRY_WINDOW_MS ? previous.id : crypto.randomUUID();
    kept.current[kind] = { id, at: previous?.id === id ? previous.at : Date.now() };
    return id;
  };

  const send = async (kind: WorkerKind) => {
    const id = idFor(kind);
    let outcome: ActionResult<{ message: string }>;
    try {
      outcome = await recordLoneWorkerEvent({ sessionId, id, kind });
    } catch {
      outcome = { ok: false, code: "unavailable", message: "" };
    }
    if (!outcomeUnknown(outcome)) delete kept.current[kind];
    if (!outcome.ok && kind === "help") {
      // Never worded as an ordinary save that failed: say what to do now.
      outcome = { ...outcome, message: t("scheduling.loneWorker.mine.helpNotSent") };
    } else if (!outcome.ok && outcome.message === "") {
      outcome = { ...outcome, message: t("care.errors.unavailable") };
    }
    if (outcome.ok) setSuccess(outcome.data.message);
    setResult(outcome);
    if (outcome.ok && kind === "finish") {
      router.push("/lone-working?done=finished", { scroll: false });
    } else if (outcome.ok) {
      router.refresh();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {confirmingFinish ? (
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="m-0 font-semibold">
            {t("scheduling.loneWorker.mine.finishQuestion")}
          </legend>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="destructive"
              icon={<Square size={16} strokeWidth={1.5} />}
              disabled={pending}
              onClick={() => startTransition(() => send("finish"))}
            >
              {t("scheduling.loneWorker.mine.finish")}
            </Button>
            <Button
              ref={keepGoing}
              variant="secondary"
              onClick={() => {
                setConfirmingFinish(false);
                window.setTimeout(() => finishTrigger.current?.focus(), 0);
              }}
            >
              {t("scheduling.loneWorker.mine.keepGoing")}
            </Button>
          </div>
        </fieldset>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button
            icon={<CircleCheck size={16} strokeWidth={1.5} />}
            onClick={() => startTransition(() => send("check_in"))}
            disabled={pending}
          >
            {t("scheduling.loneWorker.mine.checkIn")}
          </Button>
          <Button
            ref={finishTrigger}
            variant="secondary"
            icon={<Square size={16} strokeWidth={1.5} />}
            onClick={() => setConfirmingFinish(true)}
          >
            {t("scheduling.loneWorker.mine.finishOpen")}
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
        <p className="m-0">{t("scheduling.loneWorker.mine.helpHint")}</p>
        <div>
          <Button
            variant="destructive"
            icon={<LifeBuoy size={16} strokeWidth={1.5} />}
            onClick={() => startHelp(() => send("help"))}
          >
            {t("scheduling.loneWorker.mine.help")}
          </Button>
        </div>
      </div>
      <FormFeedback result={result} success={success} />
    </div>
  );
}

const ACK_FIELDS = ["outcome", "note"] as const;

/**
 * Acknowledge an alarm: what was done and a note. Acknowledging means having checked on the
 * worker (H-1039). While the form is being filled in the board is not read again, so the alarm
 * and the note stay; once sent, the board says what was acknowledged and, for anything but safe
 * confirmed, suggests an incident report, outside the alarm that has now closed.
 */
export function AcknowledgeForm({
  alarmId,
  version,
}: {
  readonly alarmId: string;
  readonly version: number;
}) {
  const router = useRouter();
  const ids = useFieldIds(ACK_FIELDS);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => () => stopEditing(alarmId), [alarmId]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readAcknowledge(new FormData(event.currentTarget), t);
    if (!read.ok) {
      setResult(collectedRefusal(read.problems));
      return;
    }
    startTransition(async () => {
      const outcome = await acknowledgeLoneWorkerAlarm({
        alarmId,
        outcome: read.outcome,
        note: read.note,
        version,
      });
      setResult(outcome);
      if (outcome.ok) {
        stopEditing(alarmId);
        router.push(`/lone-working/board?acknowledged=${alarmId}`, { scroll: false });
      }
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <form
        method="post"
        className="flex flex-col gap-3"
        onSubmit={submit}
        onChange={() => startEditing(alarmId)}
        noValidate
      >
        <RadioGroup<LoneWorkerOutcome>
          id={ids.outcome}
          name="outcome"
          legend={t("scheduling.loneWorker.ack.outcome")}
          hint={t("scheduling.loneWorker.ack.outcomeHint")}
          options={OUTCOMES.map((outcome) => ({
            value: outcome,
            label: t("scheduling.loneWorker.outcome", { outcome }),
          }))}
          error={errorFor(result, "outcome")}
        />
        <TextArea
          id={ids.note}
          name="note"
          label={t("scheduling.loneWorker.ack.note")}
          hint={t("scheduling.loneWorker.ack.noteHint")}
          rows={3}
          required
          maxLength={2000}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "note")}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {t("scheduling.loneWorker.ack.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("scheduling.loneWorker.ack.done")} fieldIds={ids} />
    </div>
  );
}
