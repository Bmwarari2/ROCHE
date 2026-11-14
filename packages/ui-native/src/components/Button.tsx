import { button, nativeMetrics } from "@harbour/ui/tokens";
import Check from "lucide-react-native/icons/check";
import type { Ref } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
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
  /**
   * A press held for `delayLongPress` ms. It gives exactly the same feedback as a press (haptic,
   * look and what is said); it acts when the hold registers, while the finger is still down
   * (H-1311).
   */
  readonly onLongPress?: (event: GestureResponderEvent) => void;
  readonly delayLongPress?: number;
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
  /**
   * A choice in a group (`radio`) or a tick box (`checkbox`): the state is exposed to assistive
   * technology and shown with a check icon and the filled style, never by fill alone (WCAG 1.4.1,
   * 4.1.2).
   */
  readonly selection?: { readonly kind: "radio" | "checkbox"; readonly selected: boolean };
}

/**
 * A button in the platform's own style (ADR-0138), always at least the platform's touch target
 * (44 pt on iOS, 48 dp on Android) and a full capsule:
 * - Android, Material 3: primary is a filled button, secondary a tonal one, destructive filled in
 *   the error colour; pressing shows the platform ripple.
 * - iOS 26: primary is a prominent capsule in the brand tint, secondary a grey capsule with tinted
 *   words, destructive filled in red; pressing dims it, as UIKit does.
 */
export function Button({
  label,
  onPress,
  onLongPress,
  delayLongPress,
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
  selection,
}: ButtonProps) {
  const theme = useTheme();
  const haptics = useHaptics();
  const inactive = disabled || loading;
  // A capsule while the label fits on one line; smaller corners at large text, so a wrapped label
  // never runs into the rounded ends (accessibility review H3).
  const { fontScale } = useWindowDimensions();
  const radius =
    fontScale > nativeMetrics.wrapFontScale ? nativeMetrics.wrapRadius : theme.radius.pill;
  if (selection) {
    variant = selection.selected ? "primary" : "secondary";
    if (selection.selected) Icon = Check;
  }

  const palette = theme.colors;
  const android = theme.platform === "android";
  const background =
    variant === "primary"
      ? palette.accent
      : variant === "destructive"
        ? palette.danger
        : android
          ? palette.accentContainer
          : palette.surfaceHigh;
  const foreground =
    variant === "primary"
      ? palette.onAccent
      : variant === "destructive"
        ? palette.onDanger
        : android
          ? palette.onAccentContainer
          : theme.textColors.accent;
  const feedback: ButtonHaptic = haptic ?? (variant === "destructive" ? "warning" : "selection");

  const handlePress = (event: GestureResponderEvent) => {
    if (feedback !== "none") haptics?.[feedback]();
    onPress(event);
  };
  // A long press acts as soon as it registers, as the platform's own long-press gesture does, so a
  // screen reader's long press and a slow press both act once and a cancelled tap never does.
  const handleLongPress = onLongPress
    ? (event: GestureResponderEvent) => {
        if (feedback !== "none") haptics?.[feedback]();
        onLongPress(event);
      }
    : undefined;

  return (
    <Pressable
      ref={focusRef}
      accessibilityRole={selection?.kind ?? "button"}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{
        disabled: inactive,
        busy: loading,
        ...(selection ? { checked: selection.selected, selected: selection.selected } : {}),
      }}
      disabled={inactive}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={delayLongPress}
      testID={testID}
      hitSlop={4}
      android_ripple={android ? { color: rippleColour(foreground), foreground: true } : undefined}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: Math.max(button.minHeight, theme.touchTarget),
          paddingVertical: button.paddingY,
          paddingHorizontal: android ? theme.space[3] : theme.space[2],
          borderRadius: radius,
          backgroundColor: background,
          borderColor: theme.highContrast ? palette.text : "transparent",
          // Android clips its ripple to the shape; iOS never clips the label.
          overflow: android ? "hidden" : "visible",
          // Disabled is dimmed the same on both, so the label stays readable (review L6); the
          // ripple is Android's press feedback.
          opacity: inactive ? nativeMetrics.disabledOpacity : pressed && !android ? 0.7 : 1,
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
        <Text
          variant="body"
          emphasis
          numberOfLines={2}
          style={[styles.label, { color: foreground }]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

/** The press ripple: the button's own text colour at 12% (Material 3's pressed state layer). */
function rippleColour(foreground: string): string {
  return /^#[0-9a-f]{6}$/i.test(foreground) ? `${foreground}1f` : "rgba(0,0,0,0.12)";
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
