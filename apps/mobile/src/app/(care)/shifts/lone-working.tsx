import { useTheme } from "@harbour/ui-native";
import { useStatus } from "@powersync/react";
import { ScrollView } from "react-native";
import { useSession } from "../../../app-state/session";
import { LoneWorkingPanel } from "../../../components/LoneWorkingPanel";
import { Screen } from "../../../components/Screen";
import { UploadIssues } from "../../../components/UploadIssues";
import { useClock, useLoneWorker, useMinute } from "../../../scheduling/hooks";

/**
 * Lone working on the phone (scheduling.md sections 17 and 18; SCHED-012, HZ-125). Duress is
 * offered here only, as a long press on Check in that nothing on screen tells apart.
 */
export default function LoneWorkingScreen() {
  const theme = useTheme();
  const status = useStatus();
  const { me } = useSession();
  const now = useMinute();
  const { view: clock } = useClock(now);
  const { view, asked, start, event } = useLoneWorker(now);
  const locationName = (me?.locations ?? []).find((l) => l.id === clock.locationId)?.name ?? null;
  return (
    <Screen testID="lone-working-screen">
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
        <LoneWorkingPanel
          view={view}
          connected={status.connected}
          asked={asked}
          locationId={clock.locationId}
          locationName={locationName}
          now={() => new Date()}
          onStart={start}
          onEvent={event}
        />
        <UploadIssues />
      </ScrollView>
    </Screen>
  );
}
