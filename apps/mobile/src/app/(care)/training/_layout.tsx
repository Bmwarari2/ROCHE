import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";
import { t } from "../../../i18n/t";

/** Training on the phone (mobile slice 72): the list, then a course taken offline. */
export default function TrainingLayout() {
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
      <Stack.Screen name="index" options={{ title: t("mobile.training.title") }} />
      <Stack.Screen name="[courseId]" options={{ title: t("mobile.training.title") }} />
    </Stack>
  );
}
