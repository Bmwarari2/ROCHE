import { useTheme } from "@harbour/ui-native";
import { Stack } from "expo-router";

/** Native stack inside the People tab: list, then a person's record. */
export default function PeopleLayout() {
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
      <Stack.Screen name="index" options={{ title: "People" }} />
      <Stack.Screen name="[personId]" options={{ title: "Record" }} />
    </Stack>
  );
}
