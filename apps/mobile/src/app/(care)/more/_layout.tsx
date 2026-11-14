import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";
import { rootScreen, stackScreenOptions } from "../../../components/stack-options";
import { t } from "../../../i18n/t";

/**
 * The More tab's stack (ADR-0138): the list of what does not fit in the tab bar, and each of
 * those screens, with the same native header as every other stack.
 */
export default function MoreLayout() {
  const theme = useTheme();
  return (
    <Stack screenOptions={stackScreenOptions(theme)}>
      <Stack.Screen name="index" options={rootScreen(theme, t("mobile.tabs.more"))} />
      <Stack.Screen name="handover" options={{ title: t("mobile.handover.title") }} />
      <Stack.Screen name="shifts/index" options={{ title: t("mobile.tabs.shifts") }} />
      <Stack.Screen name="shifts/lone-working" options={{ title: t("mobile.lone.title") }} />
      <Stack.Screen name="training/index" options={{ title: t("mobile.training.title") }} />
      <Stack.Screen name="training/[courseId]" options={{ title: t("mobile.training.title") }} />
      <Stack.Screen name="settings" options={{ title: t("mobile.tabs.settings") }} />
    </Stack>
  );
}
