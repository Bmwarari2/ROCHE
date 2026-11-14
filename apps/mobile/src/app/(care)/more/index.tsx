import { useTheme } from "@harbour/ui-native";
import { type Href, useRouter } from "expo-router";
import { ScrollView } from "react-native";
import { useSession } from "../../../app-state/session";
import { type MoreDestination, MoreList } from "../../../components/MoreList";
import { Screen } from "../../../components/Screen";

const HREFS: Record<MoreDestination, Href> = {
  handover: "/more/handover",
  shifts: "/more/shifts",
  training: "/more/training",
  settings: "/more/settings",
};

/**
 * More (ADR-0138): Handover, Shifts and Training for those who have them, and Settings, in one
 * grouped list. Each is one tap from here, and the tab keeps where the member was.
 */
export default function MoreScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me } = useSession();
  return (
    <Screen testID="more-screen">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustsScrollIndicatorInsets
        contentContainerStyle={{ padding: theme.space[2] }}
      >
        <MoreList
          permissions={me?.permissions ?? []}
          onOpen={(destination) => router.push(HREFS[destination])}
        />
      </ScrollView>
    </Screen>
  );
}
