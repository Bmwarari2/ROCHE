import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";
import { t } from "../../../i18n/t";

/** Native stack inside the Shifts tab: my shifts and the clock, then lone working. */
export default function ShiftsLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.bg },
        headerTintColor: theme.colors.accent,
        headerTitleStyle: { color: theme.colors.text },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.bgSecondary },
      }}
    >
      <Stack.Screen name="index" options={{ title: t("mobile.tabs.shifts") }} />
      <Stack.Screen name="lone-working" options={{ title: t("mobile.lone.title") }} />
    </Stack>
  );
}
