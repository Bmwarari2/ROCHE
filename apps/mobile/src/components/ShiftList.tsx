import { iconByName, Text, useTheme } from "@harbour/ui-native";
import { View } from "react-native";
import { t } from "../i18n/t";
import type { ShiftItem } from "../scheduling/clock-view";
import { Card } from "./Card";

/**
 * The member's own published shifts for the coming week, as synced (scheduling.md section 18;
 * SCHED-002). A shift changed after publication says so in words, never by colour alone.
 */
export function ShiftList({ items }: { readonly items: readonly ShiftItem[] }) {
  const theme = useTheme();
  const Changed = iconByName("circle-alert");
  return (
    <Card title={t("mobile.shifts.title")} testID="shift-list">
      {items.length === 0 ? (
        <Text variant="bodyDense" testID="shift-list-empty">
          {t("mobile.shifts.none")}
        </Text>
      ) : (
        items.map((item) => (
          <View
            key={item.id}
            accessible
            style={{ gap: theme.space[0.5] }}
            testID={`shift-${item.id}`}
          >
            <Text emphasis>{item.title}</Text>
            <Text variant="bodyDense">{item.when}</Text>
            <Text variant="bodyDense" tone="secondary">
              {item.kindWords}
            </Text>
            {item.now ? <Text variant="bodyDense">{t("mobile.shifts.underWay")}</Text> : null}
            {item.changed ? (
              <View style={{ flexDirection: "row", gap: theme.space[1], alignItems: "center" }}>
                <Changed
                  color={theme.colors.text}
                  size={20}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                />
                <Text variant="bodyDense" emphasis style={{ flexShrink: 1 }}>
                  {item.changed}
                </Text>
              </View>
            ) : null}
          </View>
        ))
      )}
    </Card>
  );
}
