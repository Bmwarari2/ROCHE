import { button } from "@harbour/ui/tokens";
import type { Ref } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { useHaptics, useTheme } from "../theme/ThemeProvider";
import { ICON_STROKE_WIDTH, type LucideIcon } from "./icons";
import { Text } from "./Text";

export type ButtonVariant = "primary" | "secondary" | "destructive";
export type ButtonHaptic = "selection" | "success" | "warning" | "none";

export interface ButtonProps {
  /** Visible label, sentence case. Also the accessibility label unless one is given. */
  readonly label: string;
  readonly onPress: (event: GestureResponderEvent) => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  /** Shows a spinner and marks the button busy for assistive technology. */
  readonly loading?: boolean;
  readonly icon?: LucideIcon;
  readonly accessibilityLabel?: string;
  /** What will happen, for example "Deletes all care data stored on this device". */
  readonly accessibilityHint?: string;
  /** A ref to the pressable, so a screen can move screen reader focus back to it (WCAG 2.4.3). */
  readonly focusRef?: Ref<View>;
  /** Defaults to selection, or warning for destructive buttons. */
  readonly haptic?: ButtonHaptic;
  readonly fullWidth?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

/** Pill button from the tokens: 44 pt minimum target, 8 x 16 padding, 17 pt label. */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  icon: Icon,
  accessibilityLabel,
  accessibilityHint,
  focusRef,
  haptic,
  fullWidth = false,
  style,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const haptics = useHaptics();
  const inactive = disabled || loading;

  const palette = theme.colors;
  const background =
    variant === "primary"
      ? palette.accent
      : variant === "destructive"
        ? palette.danger
        : palette.bgSecondary;
  const foreground = variant === "secondary" ? palette.text : palette.onAccent;
  const textTone = variant === "secondary" ? "primary" : "onAccent";
  const feedback: ButtonHaptic = haptic ?? (variant === "destructive" ? "warning" : "selection");

  const handlePress = (event: GestureResponderEvent) => {
    if (feedback !== "none") haptics?.[feedback]();
    onPress(event);
  };

  return (
    <Pressable
      ref={focusRef}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={handlePress}
      testID={testID}
      hitSlop={4}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: Math.max(button.minHeight, theme.touchTarget),
          paddingVertical: button.paddingY,
          paddingHorizontal: button.paddingX,
          borderRadius: theme.radius.pill,
          backgroundColor: background,
          borderColor: theme.highContrast ? palette.text : "transparent",
          opacity: inactive ? 0.5 : pressed ? 0.75 : 1,
        },
        fullWidth && styles.fullWidth,
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator color={foreground} accessibilityElementsHidden />
        ) : Icon ? (
          <Icon
            color={foreground}
            size={20}
            strokeWidth={ICON_STROKE_WIDTH}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        ) : null}
        <Text variant="body" tone={textTone} emphasis numberOfLines={2} style={styles.label}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  fullWidth: { alignSelf: "stretch" },
  content: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { textAlign: "center" },
});
