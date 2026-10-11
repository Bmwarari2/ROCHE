import { ThemeProvider, type Theme as UiTheme, useTheme } from "@harbour/ui-native";
import { PowerSyncContext } from "@powersync/react";
import {
  DarkTheme,
  DefaultTheme,
  type Theme as NavigationTheme,
  ThemeProvider as NavigationThemeProvider,
  Stack,
} from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PreferencesProvider, usePreferences } from "../app-state/preferences";
import { SessionProvider, useSession } from "../app-state/session";
import { useVault, VaultProvider } from "../app-state/vault";
import { LockScreen } from "../components/LockScreen";
import { expoHaptics } from "../platform/haptics";

function navigationTheme(theme: UiTheme): NavigationTheme {
  const base = theme.scheme === "dark" ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: theme.scheme === "dark",
    colors: {
      ...base.colors,
      primary: theme.colors.accent,
      background: theme.colors.bgSecondary,
      card: theme.colors.bg,
      text: theme.colors.text,
      border: theme.colors.border,
      notification: theme.colors.danger,
    },
  };
}

function RootNavigator() {
  const theme = useTheme();
  const session = useSession();
  const vault = useVault();
  const navTheme = useMemo(() => navigationTheme(theme), [theme]);

  const signedIn = session.phase === "signedIn";
  const ready = signedIn && vault.db !== null;
  const locked = signedIn && vault.status !== "unlocked";

  const stack = (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.bgSecondary },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Protected guard={session.phase === "signedOut"}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="mode" />
        <Stack.Screen name="(care)" />
        <Stack.Screen name="manage" />
        <Stack.Screen name="family" />
      </Stack.Protected>
    </Stack>
  );

  return (
    <NavigationThemeProvider value={navTheme}>
      <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
      {/* Every touch restarts the idle auto-lock timer without taking the touch. */}
      <View
        style={styles.fill}
        onStartShouldSetResponderCapture={() => {
          vault.touch();
          return false;
        }}
      >
        <View
          style={styles.fill}
          importantForAccessibility={locked ? "no-hide-descendants" : "auto"}
          accessibilityElementsHidden={locked}
        >
          {vault.db ? (
            <PowerSyncContext.Provider value={vault.db}>{stack}</PowerSyncContext.Provider>
          ) : (
            stack
          )}
        </View>
        {locked ? <LockScreen /> : null}
      </View>
    </NavigationThemeProvider>
  );
}

function ThemedApp() {
  const { preferences } = usePreferences();
  return (
    <ThemeProvider preference={preferences.theme} haptics={expoHaptics}>
      <SessionProvider>
        <VaultProvider>
          <RootNavigator />
        </VaultProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <PreferencesProvider>
        <ThemedApp />
      </PreferencesProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
