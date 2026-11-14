import { useTheme } from "@harbour/ui-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppMode } from "../app-state/preferences-model";
import { useSession } from "../app-state/session";
import { ModeChooserView } from "../components/ModeChooserView";
import { appEnv } from "../config/app-env";

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
      <ModeChooserView demo={appEnv.demoMode} onChoose={choose} />
    </SafeAreaView>
  );
}
