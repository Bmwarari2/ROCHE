import { Text, useTheme } from "@harbour/ui-native";
import type { ReactNode } from "react";
import { View } from "react-native";

interface CardProps {
  /** Spoken as a heading. */
  readonly title?: string;
  readonly children: ReactNode;
  readonly testID?: string;
}

/** A bordered card on the screen background, with an optional heading. */
export function Card({ title, children, testID }: CardProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: theme.colors.card,
        borderRadius: theme.radius.card,
        borderColor: theme.colors.border,
        borderWidth: 1,
        padding: theme.space[2],
        gap: theme.space[1.5],
      }}
    >
      {title ? (
        <Text variant="bodyDense" tone="secondary" emphasis accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}
