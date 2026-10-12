import { Button, Text, useTheme } from "@harbour/ui-native";
import LockKeyhole from "lucide-react-native/icons/lock-keyhole";
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSession } from "../app-state/session";
import { useVault } from "../app-state/vault";
import { SignOutControl } from "./SignOutControl";

/**
 * Covers the whole app while it is locked (cold start and idle auto-lock). The first unlock after
 * launch reads the database key, which shows the system biometric prompt; later unlocks use strong
 * biometrics with the passcode as fallback. Primary actions sit in the lower part of the screen.
 */
export function LockScreen() {
  const theme = useTheme();
  const vault = useVault();
  const { me } = useSession();
  const prompted = useRef(false);

  // Prompt once automatically when the lock appears; after a cancel the user taps Unlock.
  useEffect(() => {
    if (prompted.current) return;
    prompted.current = true;
    void vault.unlock();
  }, [vault.unlock]);

  return (
    <View
      testID="lock-screen"
      accessibilityViewIsModal
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.bg }]}
    >
      <SafeAreaView style={[styles.safe, { padding: theme.space[3] }]}>
        <View style={[styles.top, { gap: theme.space[2] }]}>
          <LockKeyhole
            color={theme.colors.text}
            size={48}
            strokeWidth={1.5}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          <Text variant="title" accessibilityRole="header">
            Harbour is locked
          </Text>
          <Text tone="secondary">
            {me ? `Signed in as ${me.user.name}.` : null} Unlock with Face ID, fingerprint or your
            device passcode.
          </Text>
          {vault.error ? (
            <Text tone="danger" accessibilityRole="alert" testID="lock-error">
              {vault.error}
            </Text>
          ) : null}
        </View>
        <View style={{ gap: theme.space[1.5] }}>
          <Button
            label={vault.status === "unlocking" ? "Unlocking" : "Unlock"}
            onPress={() => {
              void vault.unlock();
            }}
            loading={vault.status === "unlocking"}
            fullWidth
            testID="unlock-button"
          />
          <SignOutControl variant="secondary" testID="lock-sign-out" />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, justifyContent: "space-between" },
  top: { flex: 1, justifyContent: "center", alignItems: "flex-start" },
});
