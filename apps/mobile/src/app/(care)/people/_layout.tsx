import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";
import { announceReturned } from "../../../care/announce-after-return";
import { rootScreen, stackScreenOptions } from "../../../components/stack-options";
import { t } from "../../../i18n/t";

/**
 * Native stack inside the People tab: list, a person's record, and the Care mode screens for that
 * person (note, chart, body map, care plan, risk assessments), each with the point-of-care header.
 */
export default function PeopleLayout() {
  const theme = useTheme();
  return (
    <Stack
      // A form's save confirmation is said once the screen it returns to has appeared (HZ-001).
      screenListeners={{
        transitionEnd: (event) => {
          if (!event.data.closing) announceReturned();
        },
      }}
      screenOptions={stackScreenOptions(theme)}
    >
      <Stack.Screen name="index" options={rootScreen(theme, t("mobile.tabs.people"))} />
      <Stack.Screen name="[personId]/index" options={{ title: t("mobile.person.title") }} />
      <Stack.Screen name="[personId]/note" options={{ title: t("mobile.note.title") }} />
      <Stack.Screen name="[personId]/chart" options={{ title: t("mobile.chart.choose") }} />
      <Stack.Screen name="[personId]/body-map" options={{ title: t("mobile.bodyMap.title") }} />
      <Stack.Screen name="[personId]/care-plan" options={{ title: t("mobile.carePlan.title") }} />
      <Stack.Screen name="[personId]/risks" options={{ title: t("mobile.risks.title") }} />
    </Stack>
  );
}
