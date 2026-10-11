import { ukIsoDate } from "@harbour/domain";
import { FlagChip, iconByName, Text, useTheme } from "@harbour/ui-native";
import { useQuery, useStatus } from "@powersync/react";
import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, View } from "react-native";
import { useSession } from "../../app-state/session";
import { useVault } from "../../app-state/vault";
import {
  useHeldEntryCount,
  useQueuedChanges,
  useTenantId,
  useUploadIssues,
} from "../../care/hooks";
import { resuscitationFlag } from "../../care/person-summary";
import { type AdvanceCareRow, ALL_ADVANCE_CARE_SQL, byPerson } from "../../care/queries";
import { syncSummary } from "../../care/sync-summary";
import { Card } from "../../components/Card";
import { PersonListItem } from "../../components/PersonListItem";
import { Screen } from "../../components/Screen";
import { UploadIssues } from "../../components/UploadIssues";
import { appEnv } from "../../config/app-env";
import { STALE_AFTER_MS } from "../../config/constants";
import { t } from "../../i18n/t";
import { type PersonView, toPersonView } from "../../people/person-view";
import { PEOPLE_LIST_SQL, type PersonRow, peopleListParams } from "../../people/queries";
import { useRecordScreenProtection } from "../../security/use-record-protection";
import { lastSyncedAtOf } from "../../sync/sync-state";

/**
 * Today (section 17.1): the people assigned to this user, from the encrypted database, and the
 * sync status spelled out: last successful sync, changes waiting to upload, and entries the
 * server refused (HZ-002, HZ-006). Tasks, alerts and handover join in slice 10 part 2.
 */
export default function TodayScreen() {
  useRecordScreenProtection("today");
  const theme = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const vault = useVault();
  const status = useStatus();
  const tenantId = useTenantId();
  const queued = useQueuedChanges();
  const issues = useUploadIssues();
  const held = useHeldEntryCount();

  const peopleParams = useMemo(() => peopleListParams(tenantId), [tenantId]);
  const { data: rows } = useQuery<PersonRow>(PEOPLE_LIST_SQL, peopleParams);
  const tenantParams = useMemo(() => [tenantId], [tenantId]);
  const { data: advanceCare } = useQuery<AdvanceCareRow>(ALL_ADVANCE_CARE_SQL, tenantParams);

  const today = ukIsoDate(new Date());
  const people = useMemo(() => rows.map(toPersonView), [rows]);
  const flags = useMemo(() => {
    const grouped = byPerson(advanceCare);
    return new Map(
      people.map((p) => [p.id, [resuscitationFlag(grouped.get(p.id) ?? [], today).flag]]),
    );
  }, [people, advanceCare, today]);

  const summary = syncSummary({
    lastSyncedAt: appEnv.demoMode ? vault.demoSeededAt : lastSyncedAtOf(status),
    queued,
    issues: issues.length,
    held,
    demo: appEnv.demoMode,
    windowDays: vault.offlineWindowDays,
    now: new Date(),
    staleAfterMs: STALE_AFTER_MS,
  });

  const open = useCallback(
    (personId: string) => router.push({ pathname: "/people/[personId]", params: { personId } }),
    [router],
  );
  const renderItem = useCallback(
    ({ item }: { item: PersonView }) => (
      <PersonListItem person={item} onOpen={open} additionalFlags={flags.get(item.id) ?? []} />
    ),
    [open, flags],
  );

  const header = (
    <View style={{ padding: theme.space[2], gap: theme.space[2] }}>
      <View style={{ gap: theme.space[0.5] }}>
        <Text variant="title" accessibilityRole="header">
          {me
            ? t("mobile.today.greeting", { name: me.user.name.split(" ")[0] ?? "" })
            : t("mobile.today.title")}
        </Text>
        {me ? <Text tone="secondary">{me.tenant.name}</Text> : null}
      </View>
      <Card title={t("mobile.sync.title")} testID="today-sync">
        <FlagChip
          tone={summary.tone}
          icon={iconByName(summary.icon)}
          label={summary.headline}
          testID="today-sync-last"
        />
        <View accessible style={{ gap: theme.space[0.5] }}>
          {summary.queued ? <Text testID="today-sync-queued">{summary.queued}</Text> : null}
          {summary.issues ? (
            <Text tone="danger" emphasis testID="today-sync-issues">
              {summary.issues}
            </Text>
          ) : null}
          {summary.held ? (
            <Text tone="danger" emphasis testID="today-sync-held">
              {summary.held}
            </Text>
          ) : null}
          {summary.window ? (
            <Text variant="bodyDense" tone="secondary">
              {summary.window}
            </Text>
          ) : null}
        </View>
      </Card>
      <UploadIssues />
      <Text variant="eyebrow" accessibilityRole="header" testID="today-people-count">
        {t("mobile.today.peopleCount", { count: people.length })}
      </Text>
    </View>
  );

  return (
    <Screen testID="today-screen">
      <FlatList
        testID="today-people"
        data={people}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={{ paddingHorizontal: theme.space[3] }} testID="today-empty">
            <Text tone="secondary">{t("mobile.today.empty")}</Text>
          </View>
        }
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
      />
    </Screen>
  );
}
