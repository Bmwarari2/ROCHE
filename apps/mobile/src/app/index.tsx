import { Text, useTheme } from "@harbour/ui-native";
import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useSession } from "../app-state/session";
import { useVault } from "../app-state/vault";

/** Entry route: sends people to sign-in, mode choice or their mode's home. */
export default function Index() {
  const theme = useTheme();
  const session = useSession();
  const vault = useVault();

  if (session.phase === "signedOut") return <Redirect href="/sign-in" />;
  if (session.phase === "signedIn" && vault.db) {
    if (session.mode === "care") return <Redirect href="/today" />;
    if (session.mode === "manage") return <Redirect href="/manage" />;
    if (session.mode === "family") return <Redirect href="/family" />;
    return <Redirect href="/mode" />;
  }

  // Loading, or waiting behind the lock screen for the database to open.
  return (
    <View style={[styles.centre, { backgroundColor: theme.colors.bg }]} testID="splash">
      <ActivityIndicator color={theme.colors.textSecondary} accessibilityLabel="Loading" />
      <Text tone="secondary">Harbour</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
});
