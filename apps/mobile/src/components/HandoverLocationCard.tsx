import { Button, FlagChip, iconByName, Text, useTheme } from "@harbour/ui-native";
import { useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import type { FieldError } from "../care/entries";
import type {
  AcknowledgementState,
  HandoverItemView,
  HandoverStatusView,
} from "../care/handover-view";
import { type MessageKey, t } from "../i18n/t";
import { Card } from "./Card";

export interface HandoverLocationCardProps {
  readonly locationId: string;
  readonly locationName: string;
  readonly status: HandoverStatusView;
  /** True when the items shown are the latest handover on the phone, not the expected one. */
  readonly latestOnly: boolean;
  /** The items, or null when no handover is shown. */
  readonly items: readonly HandoverItemView[] | null;
  /** Words for an empty handover, said in place of a list. */
  readonly empty: string;
  readonly acknowledgement: AcknowledgementState;
  /** Writes the acknowledgement on this phone: the problem to show, or null once saved. */
  readonly onAcknowledge: (() => Promise<FieldError | null>) | null;
}

const ACK_WORDS: Partial<Record<AcknowledgementState, MessageKey>> = {
  waiting: "mobile.handover.ackWaiting",
  acknowledged: "mobile.handover.ackDone",
  new_items: "mobile.handover.ackNewItems",
};

/**
 * One home's outgoing handover on the phone (care.md rule 14 and section 6; screens gate items
 * (a), (d) and (e)): its state as an icon and a word before any item, the shift in UK time, the
 * items worded from their summaries with the person and their communication needs, and "I have
 * read this handover", which saves an acknowledgement over the items shown and says it waits to
 * upload. Buttons are 44 pt targets.
 */
export function HandoverLocationCard({
  locationId,
  locationName,
  status,
  latestOnly,
  items,
  empty,
  acknowledgement,
  onAcknowledge,
}: HandoverLocationCardProps) {
  const theme = useTheme();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ackWords = ACK_WORDS[acknowledgement];
  const offerAck =
    onAcknowledge !== null && (acknowledgement === "none" || acknowledgement === "new_items");

  const acknowledge = async () => {
    if (!onAcknowledge) return;
    setSaving(true);
    setProblem(null);
    try {
      const error = await onAcknowledge();
      if (error) setProblem(t(error.key, error.values));
      else AccessibilityInfo.announceForAccessibility(t("mobile.handover.ackWaiting"));
    } catch {
      setProblem(t("mobile.handover.ackFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={locationName} testID={`handover-${locationId}`}>
      <FlagChip
        tone={status.chip.tone}
        icon={iconByName(status.chip.icon)}
        label={status.chip.label}
        testID={`handover-${locationId}-status`}
      />
      <View accessible style={{ gap: theme.space[0.5] }}>
        {status.shift ? <Text emphasis>{status.shift}</Text> : null}
        <Text testID={`handover-${locationId}-words`}>{status.words}</Text>
      </View>
      {latestOnly ? (
        <Text variant="bodyDense" tone="secondary">
          {t("mobile.handover.otherHandover")}
        </Text>
      ) : null}
      {items !== null && items.length === 0 ? (
        <Text testID={`handover-${locationId}-empty`}>{empty}</Text>
      ) : null}
      {(items ?? []).map((item) => (
        <View
          key={item.id}
          testID={`handover-item-${item.id}`}
          style={{
            gap: theme.space[0.5],
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: theme.space[1],
          }}
        >
          <View accessible style={{ gap: theme.space[0.5] }}>
            {item.person ? <Text emphasis>{item.person}</Text> : null}
            {item.communicationLabel ? (
              <FlagChip
                tone="info"
                icon={iconByName("message-square-text")}
                label={item.communicationLabel}
                testID={`handover-item-${item.id}-communication`}
              />
            ) : null}
            <Text>{item.words}</Text>
            {item.when ? (
              <Text variant="bodyDense" tone="secondary">
                {item.when}
              </Text>
            ) : null}
          </View>
          {item.lateAddition || item.newForReader ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
              {item.newForReader ? (
                <FlagChip
                  tone="warning"
                  icon={iconByName("circle-alert")}
                  label={t("mobile.handover.newForYou")}
                  testID={`handover-item-${item.id}-new`}
                />
              ) : null}
              {item.lateAddition ? (
                <FlagChip
                  tone="neutral"
                  icon={iconByName("clock")}
                  label={t("mobile.handover.lateAddition")}
                  testID={`handover-item-${item.id}-late`}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      ))}
      {acknowledgement === "waiting" ? (
        <FlagChip
          tone="info"
          icon={iconByName("cloud-upload")}
          label={t("mobile.handover.waiting")}
          testID={`handover-${locationId}-ack-chip`}
        />
      ) : null}
      {ackWords ? <Text testID={`handover-${locationId}-ack`}>{t(ackWords)}</Text> : null}
      {offerAck ? (
        <Button
          label={
            acknowledgement === "new_items"
              ? t("mobile.handover.acknowledgeAgain")
              : t("mobile.handover.acknowledge")
          }
          accessibilityHint={t("mobile.handover.acknowledgeHint")}
          onPress={() => void acknowledge()}
          loading={saving}
          testID={`handover-${locationId}-acknowledge`}
        />
      ) : null}
      {problem ? (
        <Text
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          testID={`handover-${locationId}-problem`}
        >
          {problem}
        </Text>
      ) : null}
    </Card>
  );
}
