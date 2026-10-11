import { Button, Text, useTheme } from "@harbour/ui-native";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSession } from "../app-state/session";
import { Screen } from "./Screen";

/** Stub for the Manage and Family modes, which arrive in later phases. */
export function ComingSoon({ title, description }: { title: string; description: string }) {
  const theme = useTheme();
  const session = useSession();
  const router = useRouter();
  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
      <Screen testID={`stub-${title.toLowerCase()}`}>
        <View
          style={{
            flex: 1,
            padding: theme.space[3],
            gap: theme.space[2],
            justifyContent: "center",
          }}
        >
          <Text variant="title" accessibilityRole="header">
            {title}
          </Text>
          <Text tone="secondary">{description}</Text>
        </View>
        <View style={{ padding: theme.space[3], gap: theme.space[1.5] }}>
          <Button
            label="Switch to Care mode"
            onPress={() => {
              session.setMode("care");
              router.replace("/today");
            }}
            fullWidth
            testID="switch-to-care"
          />
          <Button
            label="Choose another mode"
            variant="secondary"
            onPress={() => router.replace("/mode")}
            fullWidth
          />
        </View>
      </Screen>
    </SafeAreaView>
  );
}
