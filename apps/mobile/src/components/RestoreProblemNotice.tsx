import { Text, useTheme } from "@harbour/ui-native";
import { StyleSheet, View } from "react-native";

/**
 * Held entries could not all be put back to be sent after sign-in (clinical review round 4, M4):
 * said on every screen, in words, until the next unlock puts them back. It cannot be dismissed.
 */
export function RestoreProblemNotice({ message }: { readonly message: string }) {
  const theme = useTheme();
  return (
    <View
      testID="restore-problem"
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={[
        styles.notice,
        {
          backgroundColor: theme.colors.card,
          borderBottomColor: theme.colors.border,
          padding: theme.space[2],
        },
      ]}
    >
      <Text tone="danger" emphasis>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { borderBottomWidth: StyleSheet.hairlineWidth },
});
