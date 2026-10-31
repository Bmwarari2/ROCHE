import { SplitView, Text, useSplitLayout, useTheme } from "@harbour/ui-native";
import { useQuery, useStatus } from "@powersync/react";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { useSession } from "../../app-state/session";
import { useVault } from "../../app-state/vault";
import { useMoveTask, useTaskRefusal, useTenantId } from "../../care/hooks";
import { META_VALUE_SQL, ROUND_TASKS_SQL } from "../../care/queries";
import {
  managesTasks,
  type RoundItem,
  type RoundTaskRow,
  roundEmpty,
  roundHeader,
  roundItems,
} from "../../care/round-view";
import { useCarePerson } from "../../components/CarePersonHeader";
import { type OpenPersonScreen, PersonRecord } from "../../components/PersonRecord";
import { RoundHeaderCard } from "../../components/RoundHeaderCard";
import { RoundTaskCard } from "../../components/RoundTaskCard";
import { Screen } from "../../components/Screen";
import { UploadIssues } from "../../components/UploadIssues";
import { appEnv } from "../../config/app-env";
import { t } from "../../i18n/t";
import { useRecordScreenProtection } from "../../security/use-record-protection";
import { OFFLINE_DAYS_META_ID, parseCachedOfflineDays } from "../../sync/offline-days";
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

/** The person shown beside the round on a tablet, and the task they were opened for, if any. */
interface Shown {
  readonly personId: string;
  readonly task: string | null;
}

/**
 * The round (care.md rule 8 and section 6; CARE-013): the open tasks on this device, overdue
 * first, each with its status as an icon and a word, marked done or not done (with a reason) on
 * the phone and sent when there is a connection. What the phone holds and from when is said first
 * (HZ-028), and the needs-attention list sits above the tasks, so a change Harbour did not take is
 * never out of sight (screens gate item (g); HZ-006).
 *
 * On a tablet in landscape (MOB-013) the round stays on the left and a person's record, with its
 * point-of-care header (HZ-001), opens on the right: "Show record" on a task, or "Record the
 * entry" for a task that needs evidence. A note or chart started from that record opens over the
 * People tab with the record beneath it, as on a phone, so saving returns to the person.
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
  // The member first: an entry saved here answers a task for them (answered-tasks.ts).
  const params = useMemo(() => [me?.tenantUserId ?? "", tenantId], [me?.tenantUserId, tenantId]);
  const { data: rows, isLoading } = useQuery<RoundTaskRow>(ROUND_TASKS_SQL, params);
  const taskRefusal = useTaskRefusal();
  const daysParams = useMemo(() => [OFFLINE_DAYS_META_ID], []);
  const { data: daysRows } = useQuery<{ value: string }>(META_VALUE_SQL, daysParams);
  const offlineDays = useMemo(() => parseCachedOfflineDays(daysRows[0]?.value), [daysRows]);
  // Until the tenant and the first read are known the round is loading, never "no tasks on this
  // phone" (#123 clinical review, L9).
  const loading = !tenantId || isLoading;
  const items = useMemo(() => roundItems(rows, now), [rows, now]);
  const manager = managesTasks(me?.permissions);
  const lastSyncedAt = appEnv.demoMode ? vault.demoSeededAt : lastSyncedAtOf(status);
  const header = roundHeader({
    now,
    offlineDays,
    lastSyncedAt,
    demo: appEnv.demoMode,
  });

  const layout = useSplitLayout();
  const split = layout.mode === "split";
  const [shown, setShown] = useState<Shown | null>(null);
  const { person: shownPerson } = useCarePerson(shown?.personId ?? "");

  const recordEvidence = useCallback(
    (item: RoundItem) => {
      if (!item.personId) return;
      // The task's id only: the record looks it up on this device and shows its synced title.
      if (split) setShown({ personId: item.personId, task: item.id });
      else
        router.push({
          pathname: "/people/[personId]",
          params: { personId: item.personId, task: item.id },
        });
    },
    [router, split],
  );
  const showPerson = useCallback((item: RoundItem) => {
    if (item.personId) setShown({ personId: item.personId, task: null });
  }, []);
  const openScreen = useCallback<OpenPersonScreen>(
    (personId, screen, params) => {
      router.push({
        pathname: "/people/[personId]",
        params: { personId, ...(params.task ? { task: params.task } : {}) },
      });
      router.push({ pathname: `/people/[personId]/${screen}`, params: { personId, ...params } });
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
          refusal={taskRefusal(item.row, item.row.person_location_id)}
          onShowPerson={split ? showPerson : undefined}
          personShown={split && shown !== null && item.personId === shown.personId}
        />
      </View>
    ),
    [theme, manager, moveTask, recordEvidence, taskRefusal, split, showPerson, shown],
  );

  const list = (
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
              loading
                ? t("mobile.round.loading")
                : items.length === 0
                  ? roundEmpty({ lastSyncedAt, demo: appEnv.demoMode })
                  : null
            }
            loading={loading}
          />
          <UploadIssues />
        </View>
      }
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={7}
      extraData={shown}
    />
  );

  return (
    <Screen testID="round-screen">
      {layout.mode === "split" ? (
        <SplitView
          testID="round-split"
          listWidth={layout.listWidth}
          list={list}
          detailKey={shown ? `${shown.personId}:${shown.task ?? ""}` : null}
          detailTitle={
            shown && shownPerson
              ? t("mobile.split.recordOf", { person: shownPerson.displayName })
              : null
          }
          detail={
            shown ? (
              <View testID="person-screen" style={{ flex: 1 }}>
                <PersonRecord
                  key={`${shown.personId}:${shown.task ?? ""}`}
                  personId={shown.personId}
                  task={shown.task}
                  onOpenScreen={openScreen}
                />
              </View>
            ) : (
              <View style={{ padding: theme.space[3] }} testID="round-split-empty">
                <Text tone="secondary">{t("mobile.split.chooseTask")}</Text>
              </View>
            )
          }
        />
      ) : (
        list
      )}
    </Screen>
  );
}
