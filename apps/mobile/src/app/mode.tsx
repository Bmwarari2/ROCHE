import { ListItem, Text, useTheme } from "@harbour/ui-native";
import { useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppMode } from "../app-state/preferences-model";
import { useSession } from "../app-state/session";
import { t } from "../i18n/t";

const modes: ReadonlyArray<{ mode: AppMode; title: string; subtitle: string }> = (
  ["care", "manage", "family"] as const
).map((mode) => ({
  mode,
  title: t("mobile.mode.title", { mode }),
  subtitle: t("mobile.mode.subtitle", { mode }),
}));

/** Mode chosen after sign-in (section 17). Only Care mode is built in Phase 0. */
export default function ModeScreen() {
  const theme = useTheme();
  const session = useSession();
  const router = useRouter();

  const choose = (mode: AppMode) => {
    session.setMode(mode);
    router.replace(mode === "care" ? "/today" : mode === "manage" ? "/manage" : "/family");
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: theme.colors.bgSecondary }}
      testID="mode-screen"
    >
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
        <View style={{ gap: theme.space[1] }}>
          <Text variant="title" accessibilityRole="header">
            {t("mobile.mode.choose")}
          </Text>
          <Text tone="secondary">{t("mobile.mode.changeLater")}</Text>
        </View>
        <View
          style={{
            borderRadius: theme.radius.card,
            overflow: "hidden",
            borderColor: theme.colors.border,
            borderWidth: 1,
          }}
        >
          {modes.map((item) => (
            <ListItem
              key={item.mode}
              testID={`mode-${item.mode}`}
              title={item.title}
              subtitle={item.subtitle}
              onPress={() => choose(item.mode)}
            />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
