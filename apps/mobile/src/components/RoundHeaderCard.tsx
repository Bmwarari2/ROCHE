import { FlagChip, iconByName, Text, useTheme } from "@harbour/ui-native";
import { View } from "react-native";
import type { RoundHeader } from "../care/round-view";
import { t } from "../i18n/t";
import { Card } from "./Card";

/**
 * What the round on this phone holds, from when, and that it may be incomplete (screens gate item
 * (d); HZ-028), said before any task and again in place of an empty list, which never reads as
 * "nothing due".
 */
export function RoundHeaderCard({
  header,
  empty,
  loading = false,
}: {
  readonly header: RoundHeader;
  /** The words for an empty round, or null when there are tasks. */
  readonly empty: string | null;
  /** Still reading the round: say so, never "no tasks on this phone" (#123 clinical review, L9). */
  readonly loading?: boolean;
}) {
  const theme = useTheme();
  return (
    <Card title={t("mobile.round.onThisPhone")} testID="round-header">
      <View accessible style={{ gap: theme.space[0.5] }}>
        <Text testID="round-window">{header.holds}</Text>
        <Text variant="bodyDense" tone="secondary" testID="round-synced">
          {header.synced}
        </Text>
        <Text variant="bodyDense" tone="secondary">
          {header.incomplete}
        </Text>
      </View>
      {loading ? (
        <Text testID="round-loading">{t("mobile.round.loading")}</Text>
      ) : empty ? (
        <View style={{ gap: theme.space[1] }}>
          <FlagChip
            tone="neutral"
            icon={iconByName("circle-help")}
            label={t("mobile.round.noneOnPhone")}
            testID="round-empty-chip"
          />
          <Text testID="round-empty">{empty}</Text>
        </View>
      ) : null}
    </Card>
  );
}
