import { Button, Text, useTheme } from "@harbour/ui-native";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useVault } from "../app-state/vault";
import { appEnv } from "../config/app-env";
import { t } from "../i18n/t";
import { AppSyncBanner } from "./AppSyncBanner";
import { DemoNotice } from "./DemoNotice";
import { RestoreProblemNotice } from "./RestoreProblemNotice";

interface ScreenProps {
  readonly children: ReactNode;
  /** Signed-in screens show the sync banner; set false only for screens without care data. */
  readonly syncBanner?: boolean;
  readonly testID?: string;
}

/**
 * Base layout for signed-in screens: themed background, sync banner, demo-mode notice, a warning
 * when the device integrity check reports a rooted or jailbroken device (section 17.2; the check
 * itself is still a stub, ADR-0029), the one-off notice shown after the device's data had to be
 * reset, and held entries that could not be put back after sign-in (clinical review round 4, M4).
 */
export function Screen({ children, syncBanner = true, testID }: ScreenProps) {
  const theme = useTheme();
  const vault = useVault();
  return (
    <View testID={testID} style={[styles.root, { backgroundColor: theme.colors.bgSecondary }]}>
      {syncBanner ? <AppSyncBanner /> : null}
      {appEnv.demoMode ? <DemoNotice /> : null}
      {vault.integrity?.status === "compromised" ? (
        <View
          testID="integrity-warning"
          accessibilityRole="alert"
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
            {t("mobile.security.compromised")}
          </Text>
        </View>
      ) : null}
      {vault.restoreProblem ? <RestoreProblemNotice message={vault.restoreProblem} /> : null}
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
          <Button
            label={t("mobile.resetNotice.dismiss")}
            variant="secondary"
            onPress={vault.dismissResetNotice}
          />
        </View>
      ) : null}
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  notice: { borderBottomWidth: StyleSheet.hairlineWidth },
  content: { flex: 1 },
});
