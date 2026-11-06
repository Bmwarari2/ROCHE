import { Button, iconByName, Text, useTheme } from "@harbour/ui-native";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, View } from "react-native";
import { parseInstant, ukDateTimeParts } from "../care/time";
import { t } from "../i18n/t";
import type { LoneWorkKind } from "../scheduling/actions";
import type { WriteOutcome } from "../scheduling/hooks";
import {
  helpState,
  type LoneWorkerEventKind,
  type LoneWorkerView,
} from "../scheduling/lone-worker-view";
import { Card } from "./Card";

/**
 * Lone working on the phone (scheduling.md sections 17 and 18; SCHED-012, HZ-125): start, check
 * in, ask for help and finish, saved on the phone and sent when there is a connection.
 *
 * Duress is a long press on Check in. It looks, sounds and reads exactly like a check-in: the same
 * button, the same haptic, the same answer ("Checked in at 10:02"), the same line in the session
 * and the same count waiting to send. Nothing on screen names it. The web never offers it.
 *
 * Help says the truth: it is being sent, or it has not reached anyone because the phone has no
 * connection, with "If you are in danger, call 999" either way.
 */

/**
 * The choices offered when starting. Product presets, not statutory figures: the API checks the
 * organisation's own limits from the rate table (`lone_worker.check_in_min_minutes`,
 * `check_in_max_minutes`, `session_max_hours`) and refuses in words anything outside them.
 */
export const LONE_HOURS = [2, 4, 8] as const;
export const LONE_INTERVALS = [30, 60] as const;
const WORK_KINDS: readonly LoneWorkKind[] = ["domiciliary_visit", "night_shift", "other"];

/** How long Check in is held for duress: long enough not to happen by accident. */
export const DURESS_HOLD_MS = 1500;

type Answer =
  | { readonly kind: "checked_in"; readonly time: string }
  | { readonly kind: "help" }
  | { readonly kind: "finished" }
  | { readonly kind: "started" }
  | { readonly kind: "problem"; readonly outcome: WriteOutcome };

function Choice({
  label,
  chosen,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly chosen: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}) {
  // The word "chosen" says it, not the colour alone.
  return (
    <Button
      label={chosen ? t("mobile.lone.chosen", { label }) : label}
      variant={chosen ? "primary" : "secondary"}
      onPress={onPress}
      testID={testID}
    />
  );
}

export function LoneWorkingPanel({
  view,
  connected,
  answeredAt,
  locationId,
  locationName,
  now,
  onStart,
  onEvent,
}: {
  readonly view: LoneWorkerView;
  readonly connected: boolean;
  /** When Harbour last answered about the member's session (kept on the phone), or null. */
  readonly answeredAt: string | null;
  readonly locationId: string | null;
  readonly locationName: string | null;
  readonly now: () => Date;
  readonly onStart: (input: {
    readonly locationId: string | null;
    readonly workKind: LoneWorkKind;
    readonly hours: number;
    readonly intervalMinutes: number;
  }) => Promise<WriteOutcome>;
  readonly onEvent: (kind: LoneWorkerEventKind) => Promise<WriteOutcome>;
}) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [workKind, setWorkKind] = useState<LoneWorkKind>("domiciliary_visit");
  const [hours, setHours] = useState<number>(4);
  const [checkEvery, setCheckEvery] = useState<number>(60);

  const [helping, setHelping] = useState(false);
  // Said aloud as well as shown: a live region or alert role is not read on iOS.
  const say = (words: string | null) => {
    if (words) AccessibilityInfo.announceForAccessibility(words);
  };

  const giveAnswer = (next: Answer) => {
    setAnswer(next);
    say(
      next.kind === "help"
        ? connected
          ? t("mobile.lone.helpAsked")
          : t("mobile.lone.helpWaiting")
        : wordsFor(next),
    );
  };

  const send = async (kind: LoneWorkerEventKind) => {
    // Help never waits behind another press.
    const setPending = kind === "help" ? setHelping : setBusy;
    setPending(true);
    const at = now();
    const outcome = await onEvent(kind);
    setPending(false);
    if (outcome !== "saved") {
      giveAnswer({ kind: "problem", outcome });
      return;
    }
    // A duress press answers exactly as a check-in, aloud too (HZ-125).
    if (kind === "check_in" || kind === "duress") {
      giveAnswer({ kind: "checked_in", time: ukDateTimeParts(at).time });
    } else if (kind === "help") giveAnswer({ kind: "help" });
    else giveAnswer({ kind: "finished" });
  };

  const confirmFinish = () => {
    Alert.alert(t("mobile.lone.finishTitle"), t("mobile.lone.finishBody"), [
      { text: t("mobile.lone.keep"), style: "cancel" },
      { text: t("mobile.lone.finish"), onPress: () => void send("finish") },
    ]);
  };

  const start = async () => {
    setBusy(true);
    const outcome = await onStart({ locationId, workKind, hours, intervalMinutes: checkEvery });
    setBusy(false);
    giveAnswer(outcome === "saved" ? { kind: "started" } : { kind: "problem", outcome });
  };

  // An overdue check-in is said aloud when it becomes overdue, not only shown.
  const wasOverdue = useRef(view.overdue);
  useEffect(() => {
    if (view.overdue && !wasOverdue.current && view.due) {
      AccessibilityInfo.announceForAccessibility(view.due);
    }
    wasOverdue.current = view.overdue;
  }, [view.overdue, view.due]);

  const answerText = wordsFor(answer);
  const Warning = iconByName("circle-alert");
  const warningIcon = (
    <Warning
      color={theme.colors.danger}
      size={20}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
  const row = { flexDirection: "row", gap: theme.space[1], alignItems: "flex-start" } as const;

  function wordsFor(a: Answer | null): string | null {
    if (!a) return null;
    switch (a.kind) {
      case "checked_in":
        return t("mobile.lone.checkedIn", { time: a.time });
      case "help":
        return null; // Said by the help line below, which stays while help waits.
      case "finished":
        return t("mobile.lone.finished");
      case "started":
        return t("mobile.shifts.saved");
      case "problem":
        return a.outcome === "no_location"
          ? t("mobile.shifts.noLocation")
          : t("mobile.shifts.notSaved");
    }
  }

  // The help line says only what is true (HZ-125): refused, waiting, being sent, or with Harbour.
  const help = helpState(view, connected, answer?.kind === "help");
  const helpText =
    help === "refused"
      ? t("mobile.lone.helpRefused")
      : help === "waiting"
        ? t("mobile.lone.helpWaiting")
        : help === "sending"
          ? t("mobile.lone.helpAsked")
          : help === "received"
            ? t("mobile.lone.helpReceived")
            : null;
  const answeredTime = answeredAt ? (parseInstant(answeredAt) ?? null) : null;

  return (
    <Card title={t("mobile.lone.title")} testID="lone-working">
      {view.kind === "off" ? (
        <Text testID="lone-off">{t("mobile.lone.off")}</Text>
      ) : view.kind === "none" ? (
        <View style={{ gap: theme.space[1] }}>
          <Text testID="lone-none">{t("mobile.lone.none")}</Text>
          {view.startRefused ? (
            <View style={row}>
              {warningIcon}
              <Text tone="danger" emphasis style={{ flexShrink: 1 }} testID="lone-start-refused">
                {t("mobile.lone.startRefused")}
              </Text>
            </View>
          ) : null}
          {!answeredAt ? (
            <Text variant="bodyDense" tone="secondary" testID="lone-not-asked">
              {t("mobile.lone.notAsked")}
            </Text>
          ) : null}
          {locationName ? (
            <Text variant="bodyDense" testID="lone-where">
              {t("mobile.lone.where", { location: locationName })}
            </Text>
          ) : null}
          <Text variant="bodyDense" tone="secondary" emphasis accessibilityRole="header">
            {t("mobile.lone.kindLabel")}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
            {WORK_KINDS.map((k) => (
              <Choice
                key={k}
                label={t("mobile.lone.workKind", { kind: k })}
                chosen={workKind === k}
                onPress={() => setWorkKind(k)}
                testID={`lone-kind-${k}`}
              />
            ))}
          </View>
          <Text variant="bodyDense" tone="secondary" emphasis accessibilityRole="header">
            {t("mobile.lone.lengthLabel")}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
            {LONE_HOURS.map((h) => (
              <Choice
                key={h}
                label={t("mobile.lone.hours", { count: h })}
                chosen={hours === h}
                onPress={() => setHours(h)}
                testID={`lone-hours-${h}`}
              />
            ))}
          </View>
          <Text variant="bodyDense" tone="secondary" emphasis accessibilityRole="header">
            {t("mobile.lone.intervalLabel")}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
            {LONE_INTERVALS.map((m) => (
              <Choice
                key={m}
                label={t("mobile.lone.minutes", { count: m })}
                chosen={checkEvery === m}
                onPress={() => setCheckEvery(m)}
                testID={`lone-interval-${m}`}
              />
            ))}
          </View>
          <Button
            label={t("mobile.lone.start")}
            loading={busy}
            onPress={() => void start()}
            testID="lone-start"
          />
        </View>
      ) : (
        <View style={{ gap: theme.space[1] }}>
          {view.unconfirmed ? (
            <View style={row}>
              {warningIcon}
              <Text tone="danger" emphasis style={{ flexShrink: 1 }} testID="lone-unconfirmed">
                {t("mobile.lone.unconfirmed")}
              </Text>
            </View>
          ) : null}
          <View accessible style={{ gap: theme.space[0.5] }}>
            {view.due ? (
              <View style={row}>
                {view.overdue ? warningIcon : null}
                <Text
                  emphasis
                  tone={view.overdue ? "danger" : "primary"}
                  style={{ flexShrink: 1 }}
                  testID="lone-due"
                >
                  {view.due}
                </Text>
              </View>
            ) : null}
            {view.until ? (
              <Text variant="bodyDense" tone="secondary" testID="lone-until">
                {view.until}
              </Text>
            ) : null}
            {view.waiting > 0 ? (
              <Text variant="bodyDense" testID="lone-waiting">
                {t("mobile.lone.waiting", { count: view.waiting })}
              </Text>
            ) : null}
            {answeredTime && !view.unconfirmed ? (
              <Text variant="bodyDense" tone="secondary" testID="lone-as-at">
                {t("mobile.lone.asAt", { time: ukDateTimeParts(answeredTime).time })}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
            {view.finished ? null : (
              <Button
                label={t("mobile.lone.checkIn")}
                accessibilityHint={t("mobile.lone.checkInHint")}
                loading={busy}
                onPress={() => void send("check_in")}
                onLongPress={() => void send("duress")}
                delayLongPress={DURESS_HOLD_MS}
                testID="lone-check-in"
              />
            )}
            {/* Help stays while a finish waits to send: it is always accepted (rule 17.3.7). */}
            <Button
              label={t("mobile.lone.help")}
              accessibilityHint={t("mobile.lone.helpHint")}
              variant="destructive"
              loading={helping}
              onPress={() => void send("help")}
              testID="lone-help"
            />
            {view.finished ? null : (
              <Button
                label={t("mobile.lone.finish")}
                variant="secondary"
                loading={busy}
                onPress={confirmFinish}
                testID="lone-finish"
              />
            )}
          </View>
          {view.lines.length > 0 ? (
            <View style={{ gap: theme.space[0.5] }} testID="lone-history">
              <Text variant="bodyDense" tone="secondary" emphasis accessibilityRole="header">
                {t("mobile.lone.history")}
              </Text>
              {view.lines.map((line) => (
                <Text key={line.id} variant="bodyDense" testID={`lone-line-${line.id}`}>
                  {line.waiting ? `${line.words}. ${t("mobile.lone.waitingLine")}` : line.words}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      )}
      {helpText ? (
        <View style={row}>
          {warningIcon}
          <Text
            tone="danger"
            emphasis
            accessibilityRole="alert"
            style={{ flexShrink: 1 }}
            testID="lone-help-answer"
          >
            {helpText}
          </Text>
        </View>
      ) : null}
      {answerText ? (
        <View style={row}>
          {answer?.kind === "problem" ? warningIcon : null}
          <Text
            variant="bodyDense"
            tone={answer?.kind === "problem" ? "danger" : "secondary"}
            accessibilityLiveRegion="polite"
            style={{ flexShrink: 1 }}
            testID="lone-answer"
          >
            {answerText}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}
