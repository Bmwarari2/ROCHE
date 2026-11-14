import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";
import { rootScreen, stackScreenOptions } from "../../../components/stack-options";
import { t } from "../../../i18n/t";

/** The medicines round and each person's doses (slice 69). */
export default function MedicinesLayout() {
  const theme = useTheme();
  return (
    <Stack screenOptions={stackScreenOptions(theme)}>
      <Stack.Screen name="index" options={rootScreen(theme, t("mobile.meds.title"))} />
      <Stack.Screen name="[personId]" options={{ title: t("mobile.meds.personTitle") }} />
      <Stack.Screen name="pins" options={{ title: t("mobile.meds.pinsTitle") }} />
      <Stack.Screen name="conflicts" options={{ title: t("mobile.meds.conflictsTitle") }} />
    </Stack>
  );
}
