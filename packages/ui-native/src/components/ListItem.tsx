import ChevronRight from "lucide-react-native/icons/chevron-right";
import PanelRight from "lucide-react-native/icons/panel-right";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useHaptics, useTheme } from "../theme/ThemeProvider";
import { ICON_STROKE_WIDTH } from "./icons";
import { Text } from "./Text";

export interface ListItemProps {
  readonly title: string;
  readonly subtitle?: string | null;
  /** Avatar or icon on the leading edge; hidden from assistive technology. */
  readonly leading?: ReactNode;
  /** Extra content under the subtitle, such as flags. */
  readonly accessories?: ReactNode;
  readonly onPress?: () => void;
  /** Read as one unit. Defaults to the title and subtitle. */
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly showChevron?: boolean;
  /**
   * The row whose detail is open beside the list on a tablet (MOB-013). Said in words with an icon
   * (`selectedLabel`), marked by a bar on the leading edge, and announced as selected: never by
   * colour alone.
   */
  readonly selected?: boolean;
  /** Words shown and read on the selected row, such as "Shown on the right". */
  readonly selectedLabel?: string;
  readonly testID?: string;
}

/** A tappable row at least 44 pt tall, read by screen readers as a single button. */
export function ListItem({
  title,
  subtitle,
  leading,
  accessories,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  showChevron = onPress !== undefined,
  selected = false,
  selectedLabel,
  testID,
}: ListItemProps) {
  const theme = useTheme();
  const haptics = useHaptics();
  const base = accessibilityLabel ?? [title, subtitle].filter(Boolean).join(", ");
  const label = selected && selectedLabel ? `${base}. ${selectedLabel}` : base;

  return (
    <Pressable
      testID={testID}
      accessible
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={onPress ? { selected } : undefined}
      disabled={!onPress}
      onPress={
        onPress
          ? () => {
              haptics?.selection();
              onPress();
            }
          : undefined
      }
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: theme.touchTarget,
          paddingHorizontal: theme.space[2],
          paddingVertical: theme.space[1.5],
          gap: theme.space[1.5],
          backgroundColor: pressed || selected ? theme.colors.bgSecondary : theme.colors.card,
          borderBottomColor: theme.colors.border,
          borderLeftWidth: SELECTED_BAR,
          borderLeftColor: selected ? theme.colors.accent : "transparent",
        },
      ]}
    >
      {leading ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {leading}
        </View>
      ) : null}
      <View style={[styles.body, { gap: theme.space[0.5] }]}>
        <Text emphasis numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodyDense" tone="secondary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
        {accessories}
        {selected && selectedLabel ? (
          <View
            style={[styles.selected, { gap: theme.space[0.5] }]}
            testID={testID ? `${testID}-selected` : undefined}
          >
            <PanelRight
              color={theme.textColors.accent}
              size={18}
              strokeWidth={ICON_STROKE_WIDTH}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
            <Text variant="bodyDense" tone="accent" emphasis>
              {selectedLabel}
            </Text>
          </View>
        ) : null}
      </View>
      {showChevron ? (
        <ChevronRight
          color={theme.colors.textSecondary}
          size={20}
          strokeWidth={ICON_STROKE_WIDTH}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : null}
    </Pressable>
  );
}

/** The leading bar on the selected row, in points; always drawn so the row never shifts. */
const SELECTED_BAR = 4;

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1 },
  selected: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
});
