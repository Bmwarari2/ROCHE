import { useTheme } from "@harbour/ui-native";
import { useQuery, useStatus } from "@powersync/react";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { useSession } from "../../app-state/session";
import { useVault } from "../../app-state/vault";
import { useMoveTask, useTenantId } from "../../care/hooks";
import { ROUND_TASKS_SQL } from "../../care/queries";
import {
  managesTasks,
  type RoundItem,
  type RoundTaskRow,
  roundEmpty,
  roundHeader,
  roundItems,
} from "../../care/round-view";
import { RoundHeaderCard } from "../../components/RoundHeaderCard";
import { RoundTaskCard } from "../../components/RoundTaskCard";
import { Screen } from "../../components/Screen";
import { UploadIssues } from "../../components/UploadIssues";
import { appEnv } from "../../config/app-env";
import { useRecordScreenProtection } from "../../security/use-record-protection";
import { lastSyncedAtOf } from "../../sync/sync-state";

/** The time, again each minute, so a task becomes due or overdue on the screen as it does. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The round (care.md rule 8 and section 6; CARE-013): the open tasks on this device, overdue
 * first, each with its status as an icon and a word, marked done or not done (with a reason) on
 * the phone and sent when there is a connection. What the phone holds and from when is said first
 * (HZ-028), and the needs-attention list sits above the tasks, so a change Harbour did not take is
 * never out of sight (screens gate item (g); HZ-006).
 */
export default function RoundScreen() {
  useRecordScreenProtection("round");
  const theme = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const vault = useVault();
  const status = useStatus();
  const tenantId = useTenantId();
  const moveTask = useMoveTask();
  const now = useMinute();
  const params = useMemo(() => [tenantId], [tenantId]);
  const { data: rows } = useQuery<RoundTaskRow>(ROUND_TASKS_SQL, params);
  const items = useMemo(() => roundItems(rows, now), [rows, now]);
  const manager = managesTasks(me?.permissions);
  const lastSyncedAt = appEnv.demoMode ? vault.demoSeededAt : lastSyncedAtOf(status);
  const header = roundHeader({
    now,
    windowDays: vault.offlineWindowDays,
    lastSyncedAt,
    demo: appEnv.demoMode,
  });

  const recordEvidence = useCallback(
    (item: RoundItem) => {
      if (!item.personId) return;
      router.push({
        pathname: "/people/[personId]",
        // The task's id only: the record looks it up on this device and shows its synced title.
        params: { personId: item.personId, task: item.id },
      });
    },
    [router],
  );
  const renderItem = useCallback(
    ({ item }: { item: RoundItem }) => (
      <View style={{ paddingHorizontal: theme.space[2], paddingBottom: theme.space[1.5] }}>
        <RoundTaskCard
          item={item}
          manager={manager}
          onMark={(to, reason) => moveTask(item.row, { to, reason })}
          onRecordEvidence={recordEvidence}
        />
      </View>
    ),
    [theme, manager, moveTask, recordEvidence],
  );

  return (
    <Screen testID="round-screen">
      <FlatList
        testID="round-tasks"
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListHeaderComponent={
          <View style={{ padding: theme.space[2], gap: theme.space[2] }}>
            <RoundHeaderCard
              header={header}
              empty={
                items.length === 0 ? roundEmpty({ lastSyncedAt, demo: appEnv.demoMode }) : null
              }
            />
            <UploadIssues />
          </View>
        }
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
      />
    </Screen>
  );
}
