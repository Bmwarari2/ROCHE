import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";
import { t } from "../../../i18n/t";

/** The medicines round and each person's doses (slice 69). */
export default function MedicinesLayout() {
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
      <Stack.Screen name="index" options={{ title: t("mobile.meds.title") }} />
      <Stack.Screen name="[personId]" options={{ title: t("mobile.meds.personTitle") }} />
      <Stack.Screen name="pins" options={{ title: t("mobile.meds.pinsTitle") }} />
    </Stack>
  );
}
