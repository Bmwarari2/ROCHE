import { Text, useTheme } from "@harbour/ui-native";
import { StyleSheet, View } from "react-native";
import { t } from "../i18n/t";

/**
 * The line that says the app is in demo mode, so invented people are never taken for real
 * records. Shown at the top of every signed-in screen (`Screen`) and on the mode chooser.
 */
export function DemoNotice() {
  const theme = useTheme();
  return (
    <View
      testID="demo-notice"
      style={[
        styles.notice,
        {
          backgroundColor: theme.colors.accentContainer,
          borderBottomColor: theme.colors.border,
          paddingHorizontal: theme.space[2],
          paddingVertical: theme.space[1],
        },
      ]}
    >
      <Text variant="bodyDense" style={{ color: theme.colors.onAccentContainer }}>
        {t("mobile.demo.notice")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { borderBottomWidth: StyleSheet.hairlineWidth },
});
