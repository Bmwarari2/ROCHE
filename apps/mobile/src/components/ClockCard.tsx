import { Button, iconByName, Text, useTheme } from "@harbour/ui-native";
import { useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { t } from "../i18n/t";
import type { ClockKind, ClockView } from "../scheduling/clock-view";
import type { WriteOutcome } from "../scheduling/hooks";
import { Card } from "./Card";

/**
 * Clock in, breaks and clock out (scheduling.md section 18; SCHED-004, HZ-010, HZ-124). The phone
 * saves the event with the device's time and sends it when there is a connection; it never decides
 * whether a clock-in is allowed. A refusal comes back in the API's words under "needs attention".
 */
function answerWords(outcome: WriteOutcome): string {
  return outcome === "saved"
    ? t("mobile.shifts.saved")
    : outcome === "no_location"
      ? t("mobile.shifts.noLocation")
      : t("mobile.shifts.notSaved");
}

export function ClockCard({
  view,
  onAction,
}: {
  readonly view: ClockView;
  readonly onAction: (kind: ClockKind) => Promise<WriteOutcome>;
}) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<WriteOutcome | null>(null);
  const act = async (kind: ClockKind) => {
    setBusy(true);
    const outcome = await onAction(kind);
    setBusy(false);
    setAnswer(outcome);
    // Said aloud on iOS too, where a live region is not read.
    AccessibilityInfo.announceForAccessibility(answerWords(outcome));
  };
  const Alert = iconByName("circle-alert");
  return (
    <Card title={t("mobile.clock.title")} testID="clock-card">
      <View accessible style={{ gap: theme.space[0.5] }}>
        <Text emphasis testID="clock-state">
          {view.words}
        </Text>
        <Text variant="bodyDense" tone="secondary" testID="clock-shift">
          {view.shift
            ? t("mobile.clock.forShift", { shift: view.shift.title })
            : t("mobile.clock.noShift")}
        </Text>
        {view.waiting > 0 ? (
          <Text variant="bodyDense" testID="clock-waiting">
            {t("mobile.clock.waiting", { count: view.waiting })}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
        {view.actions.map((action) => (
          <Button
            key={action.kind}
            label={action.label}
            accessibilityLabel={action.accessibilityLabel}
            variant={action.kind === "in" || action.kind === "break_end" ? "primary" : "secondary"}
            loading={busy}
            onPress={() => void act(action.kind)}
            testID={`clock-${action.kind}`}
          />
        ))}
      </View>
      {answer ? (
        <View style={{ flexDirection: "row", gap: theme.space[1], alignItems: "flex-start" }}>
          {answer === "saved" ? null : (
            <Alert
              color={theme.colors.danger}
              size={20}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          )}
          <Text
            variant="bodyDense"
            tone={answer === "saved" ? "secondary" : "danger"}
            accessibilityLiveRegion="polite"
            style={{ flexShrink: 1 }}
            testID="clock-answer"
          >
            {answerWords(answer)}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}
