import { Text, useTheme } from "@harbour/ui-native";
import type { ReactNode } from "react";
import { View } from "react-native";

interface CardProps {
  /** Spoken as a heading. */
  readonly title?: string;
  readonly children: ReactNode;
  readonly testID?: string;
}

/**
 * A card on the screen background, with an optional heading (ADR-0138): a Material 3 filled card on
 * Android, an inset grouped panel on iOS. Tone, not a border, sets it off from the page; high
 * contrast adds the border back.
 */
export function Card({ title, children, testID }: CardProps) {
  const theme = useTheme();
  const android = theme.platform === "android";
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: theme.colors.card,
        borderRadius: theme.radius.card,
        borderColor: theme.colors.border,
        borderWidth: theme.highContrast ? 1 : 0,
        padding: theme.space[2],
        gap: theme.space[1.5],
      }}
    >
      {title ? (
        <Text variant={android ? "eyebrow" : "body"} emphasis={!android} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}
