import type { ClinicalStatus } from "@harbour/ui/tokens";
import { nativeMetrics } from "@harbour/ui/tokens";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { statusAppearance, type Tone, toneAppearance } from "../logic/theme";
import { useTheme } from "../theme/ThemeProvider";
import { ICON_STROKE_WIDTH, iconByName, type LucideIcon } from "./icons";
import { Text } from "./Text";

interface ChipBodyProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly background: string;
  readonly foreground: string;
  /** A 2 pt edge where the fill alone would not stand out (warning, and danger in dark mode). */
  readonly border?: string;
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
  border,
  accessibilityLabel,
  testID,
}: ChipBodyProps) {
  const theme = useTheme();
  const android = theme.platform === "android";
  // A capsule only while the words fit on one line: at large text a wrapped chip keeps smaller
  // corners so no word runs past the fill (accessibility review H3).
  const { fontScale } = useWindowDimensions();
  const radius =
    fontScale > nativeMetrics.wrapFontScale
      ? Math.min(theme.radius.chip, nativeMetrics.wrapRadius)
      : theme.radius.chip;
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
          borderRadius: radius,
          borderWidth: border ? nativeMetrics.statusOutline : 0,
          borderColor: border ?? "transparent",
          // A capsule badge on iOS; a Material 3 chip, 32 dp tall, on Android.
          paddingHorizontal: android ? theme.space[1] : nativeMetrics.chipPaddingXIos,
          minHeight: nativeMetrics.chipMinHeight[theme.platform],
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
  const theme = useTheme();
  const appearance = statusAppearance(status, theme.colors);
  const text = label ?? appearance.label;
  return (
    <ChipBody
      icon={iconByName(appearance.icon)}
      label={text}
      background={appearance.background}
      foreground={appearance.foreground}
      border={appearance.border}
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
  const theme = useTheme();
  const { background, foreground, border } = toneAppearance(tone, theme.colors);
  return (
    <ChipBody
      icon={icon}
      label={label}
      background={background}
      foreground={foreground}
      border={border}
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
