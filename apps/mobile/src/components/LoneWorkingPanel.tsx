import { Button, Text, useTheme } from "@harbour/ui-native";
import { useState } from "react";
import { View } from "react-native";
import { ukDateTimeParts } from "../care/time";
import { t } from "../i18n/t";
import type { LoneWorkKind } from "../scheduling/actions";
import type { WriteOutcome } from "../scheduling/hooks";
import type { LoneWorkerEventKind, LoneWorkerView } from "../scheduling/lone-worker-view";
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
  asked,
  locationId,
  locationName,
  now,
  onStart,
  onEvent,
}: {
  readonly view: LoneWorkerView;
  readonly connected: boolean;
  /** Whether Harbour has answered about lone working since the screen opened. */
  readonly asked: boolean;
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

  const send = async (kind: LoneWorkerEventKind) => {
    setBusy(true);
    const at = now();
    const outcome = await onEvent(kind);
    setBusy(false);
    if (outcome !== "saved") {
      setAnswer({ kind: "problem", outcome });
      return;
    }
    // A duress press answers exactly as a check-in (HZ-125).
    if (kind === "check_in" || kind === "duress") {
      setAnswer({ kind: "checked_in", time: ukDateTimeParts(at).time });
    } else if (kind === "help") setAnswer({ kind: "help" });
    else setAnswer({ kind: "finished" });
  };

  const start = async () => {
    setBusy(true);
    const outcome = await onStart({ locationId, workKind, hours, intervalMinutes: checkEvery });
    setBusy(false);
    setAnswer(outcome === "saved" ? { kind: "started" } : { kind: "problem", outcome });
  };

  const answerText = (() => {
    if (!answer) return null;
    switch (answer.kind) {
      case "checked_in":
        return t("mobile.lone.checkedIn", { time: answer.time });
      case "help":
        return null; // Said by the help line below, which stays while help waits.
      case "finished":
        return t("mobile.lone.finished");
      case "started":
        return t("mobile.shifts.saved");
      case "problem":
        return answer.outcome === "no_location"
          ? t("mobile.shifts.noLocation")
          : t("mobile.shifts.notSaved");
    }
  })();

  const helpText =
    view.helpWaiting && !connected
      ? t("mobile.lone.helpWaiting")
      : answer?.kind === "help" || view.helpWaiting
        ? t("mobile.lone.helpAsked")
        : null;

  return (
    <Card title={t("mobile.lone.title")} testID="lone-working">
      {view.kind === "off" ? (
        <Text testID="lone-off">{t("mobile.lone.off")}</Text>
      ) : view.kind === "none" ? (
        <View style={{ gap: theme.space[1] }}>
          <Text testID="lone-none">{t("mobile.lone.none")}</Text>
          {!asked ? (
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
          <View accessible style={{ gap: theme.space[0.5] }}>
            {view.due ? (
              <Text emphasis tone={view.overdue ? "danger" : "primary"} testID="lone-due">
                {view.due}
              </Text>
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
          </View>
          {view.finished ? null : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
              <Button
                label={t("mobile.lone.checkIn")}
                accessibilityHint={t("mobile.lone.checkInHint")}
                loading={busy}
                onPress={() => void send("check_in")}
                onLongPress={() => void send("duress")}
                delayLongPress={DURESS_HOLD_MS}
                testID="lone-check-in"
              />
              <Button
                label={t("mobile.lone.help")}
                accessibilityHint={t("mobile.lone.helpHint")}
                variant="destructive"
                loading={busy}
                onPress={() => void send("help")}
                testID="lone-help"
              />
              <Button
                label={t("mobile.lone.finish")}
                variant="secondary"
                loading={busy}
                onPress={() => void send("finish")}
                testID="lone-finish"
              />
            </View>
          )}
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
        <Text tone="danger" emphasis accessibilityRole="alert" testID="lone-help-answer">
          {helpText}
        </Text>
      ) : null}
      {answerText ? (
        <Text
          variant="bodyDense"
          tone={answer?.kind === "problem" ? "danger" : "secondary"}
          accessibilityLiveRegion="polite"
          testID="lone-answer"
        >
          {answerText}
        </Text>
      ) : null}
    </Card>
  );
}
