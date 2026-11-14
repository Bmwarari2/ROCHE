import { type Theme, useTheme } from "@harbour/ui-native";
import type { Stack } from "expo-router";
import type { ComponentProps } from "react";

type StackOptions = NonNullable<ComponentProps<typeof Stack.Screen>["options"]>;

/**
 * The native header every Care mode stack uses (ADR-0138). The header is the platform's own, so
 * iOS 26 draws its Liquid Glass bar buttons and Android its Material 3 top app bar:
 * - iOS: the grouped background behind a centred title, the brand tint for bar buttons, and a
 *   large title on each tab's first screen (`rootScreen`);
 * - Android: a left-aligned 22 sp title on the page colour (Material 3's small top app bar).
 * No shadow on either: the page and the header share a colour.
 */
export function stackScreenOptions(theme: Theme): StackOptions {
  const android = theme.platform === "android";
  return {
    headerStyle: { backgroundColor: theme.colors.bgSecondary },
    headerTintColor: android ? theme.colors.text : theme.colors.accent,
    headerTitleStyle: {
      color: theme.colors.text,
      fontSize: android ? 22 : theme.type.body.fontSize,
      fontWeight: android ? "400" : "600",
    },
    headerTitleAlign: android ? "left" : "center",
    headerLargeTitleStyle: { color: theme.colors.text },
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    contentStyle: { backgroundColor: theme.colors.bgSecondary },
  };
}

/** The options for a tab's first screen: its title, large on iOS. */
export function rootScreen(theme: Theme, title: string): StackOptions {
  return { title, headerLargeTitle: theme.platform === "ios" };
}

export function useStackScreenOptions(): StackOptions {
  return stackScreenOptions(useTheme());
}
