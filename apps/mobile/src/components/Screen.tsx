import { Button, Text, useTheme } from "@harbour/ui-native";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useVault } from "../app-state/vault";
import { appEnv } from "../config/app-env";
import { AppSyncBanner } from "./AppSyncBanner";

interface ScreenProps {
  readonly children: ReactNode;
  /** Signed-in screens show the sync banner; set false only for screens without care data. */
  readonly syncBanner?: boolean;
  readonly testID?: string;
}

/**
 * Base layout for signed-in screens: themed background, sync banner, demo-mode notice, and the
 * one-off notice shown after the device's data had to be reset.
 */
export function Screen({ children, syncBanner = true, testID }: ScreenProps) {
  const theme = useTheme();
  const vault = useVault();
  return (
    <View testID={testID} style={[styles.root, { backgroundColor: theme.colors.bgSecondary }]}>
      {syncBanner ? <AppSyncBanner /> : null}
      {appEnv.demoMode ? (
        <View
          testID="demo-notice"
          style={[
            styles.demo,
            {
              backgroundColor: theme.colors.card,
              borderBottomColor: theme.colors.border,
              paddingHorizontal: theme.space[2],
              paddingVertical: theme.space[0.5],
            },
          ]}
        >
          <Text variant="bodyDense" tone="secondary">
            Demo mode: invented people, not real records.
          </Text>
        </View>
      ) : null}
      {vault.resetNotice ? (
        <View
          testID="reset-notice"
          accessibilityRole="alert"
          style={[
            styles.notice,
            {
              backgroundColor: theme.colors.card,
              borderBottomColor: theme.colors.border,
              padding: theme.space[2],
              gap: theme.space[1],
            },
          ]}
        >
          <Text tone="warning" emphasis>
            {vault.resetNotice}
          </Text>
          <Button label="Dismiss" variant="secondary" onPress={vault.dismissResetNotice} />
        </View>
      ) : null}
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  demo: { borderBottomWidth: StyleSheet.hairlineWidth },
  notice: { borderBottomWidth: StyleSheet.hairlineWidth },
  content: { flex: 1 },
});
