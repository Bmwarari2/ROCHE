import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";
import { rootScreen, stackScreenOptions } from "../../../components/stack-options";
import { t } from "../../../i18n/t";

/** Today's stack: its native header, with a large title on iOS (ADR-0138). */
export default function TodayLayout() {
  const theme = useTheme();
  return (
    <Stack screenOptions={stackScreenOptions(theme)}>
      <Stack.Screen name="index" options={rootScreen(theme, t("mobile.today.title"))} />
    </Stack>
  );
}
