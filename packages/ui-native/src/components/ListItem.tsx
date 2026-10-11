import ChevronRight from "lucide-react-native/icons/chevron-right";
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
  testID,
}: ListItemProps) {
  const theme = useTheme();
  const haptics = useHaptics();
  const label = accessibilityLabel ?? [title, subtitle].filter(Boolean).join(", ");

  return (
    <Pressable
      testID={testID}
      accessible
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
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
          backgroundColor: pressed ? theme.colors.bgSecondary : theme.colors.card,
          borderBottomColor: theme.colors.border,
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

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1 },
});
