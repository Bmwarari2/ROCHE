import type { ClinicalStatus } from "@harbour/ui/tokens";
import { StyleSheet, View } from "react-native";
import { statusAppearance, type Tone, toneAppearance } from "../logic/theme";
import { useTheme } from "../theme/ThemeProvider";
import { ICON_STROKE_WIDTH, iconByName, type LucideIcon } from "./icons";
import { Text } from "./Text";

interface ChipBodyProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly background: string;
  readonly foreground: string;
  readonly accessibilityLabel: string;
  readonly testID?: string;
}

/**
 * The shared chip shape: a rounded rectangle (radius.chip) holding an icon and a word. Status is
 * never carried by colour alone; the word is always visible and always spoken.
 */
function ChipBody({
  icon: Icon,
  label,
  background,
  foreground,
  accessibilityLabel,
  testID,
}: ChipBodyProps) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[
        styles.chip,
        {
          backgroundColor: background,
          borderRadius: theme.radius.chip,
          paddingHorizontal: theme.space[1],
          minHeight: 28,
        },
      ]}
    >
      <Icon
        color={foreground}
        size={16}
        strokeWidth={ICON_STROKE_WIDTH + 0.5}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text variant="bodyDense" tone="onAccent" emphasis style={{ color: foreground }}>
        {label}
      </Text>
    </View>
  );
}

export interface StatusChipProps {
  readonly status: ClinicalStatus;
  /** Overrides the token word, for example "Overdue by 20 minutes". Keep it a word or phrase. */
  readonly label?: string;
  readonly testID?: string;
}

/** Clinical status chip: overdue, due, done or not applicable, from the shared tokens. */
export function StatusChip({ status, label, testID }: StatusChipProps) {
  const appearance = statusAppearance(status);
  const text = label ?? appearance.label;
  return (
    <ChipBody
      icon={iconByName(appearance.icon)}
      label={text}
      background={appearance.background}
      foreground={appearance.foreground}
      accessibilityLabel={text}
      testID={testID}
    />
  );
}

export interface FlagChipProps {
  readonly tone: Tone;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

/** A safety flag (allergies, communication needs) in the same icon-plus-word chip shape. */
export function FlagChip({ tone, icon, label, accessibilityLabel, testID }: FlagChipProps) {
  const { background, foreground } = toneAppearance(tone);
  return (
    <ChipBody
      icon={icon}
      label={label}
      background={background}
      foreground={foreground}
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    paddingVertical: 2,
  },
});
