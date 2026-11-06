import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";
import { t } from "../../../i18n/t";

/**
 * Native stack inside the Round tab: the round, and the Care mode screens opened from a person's
 * record beside it on a tablet (MOB-013), so saving one returns to the round, not to another tab.
 */
export default function RoundLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.bg },
        headerTintColor: theme.colors.accent,
        headerTitleStyle: { color: theme.colors.text, fontSize: theme.type.body.fontSize },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.bgSecondary },
      }}
    >
      <Stack.Screen name="index" options={{ title: t("mobile.round.title") }} />
      <Stack.Screen name="[personId]/note" options={{ title: t("mobile.note.title") }} />
      <Stack.Screen name="[personId]/chart" options={{ title: t("mobile.chart.choose") }} />
      <Stack.Screen name="[personId]/body-map" options={{ title: t("mobile.bodyMap.title") }} />
      <Stack.Screen name="[personId]/care-plan" options={{ title: t("mobile.carePlan.title") }} />
      <Stack.Screen name="[personId]/risks" options={{ title: t("mobile.risks.title") }} />
    </Stack>
  );
}
