import { Button, Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, View } from "react-native";
import { useVault } from "../../../../app-state/vault";
import type { EntryItem } from "../../../../care/entry-view";
import { recentEntries } from "../../../../care/entry-view";
import { useRoundTaskFor, useTenantId } from "../../../../care/hooks";
import {
  MARKS_SQL,
  type MarkRow,
  NOTES_SQL,
  type NoteRow,
  OBSERVATIONS_SQL,
  type ObservationRow,
  observationParams,
  TASK_EVIDENCE_SQL,
} from "../../../../care/queries";
import { Card } from "../../../../components/Card";
import { CarePersonHeader, useCarePerson } from "../../../../components/CarePersonHeader";
import { EntryRow } from "../../../../components/EntryRow";
import { Screen } from "../../../../components/Screen";
import { UploadIssues } from "../../../../components/UploadIssues";
import { appEnv } from "../../../../config/app-env";
import { t } from "../../../../i18n/t";
import {
  type AllergyRow,
  PERSON_ALLERGIES_SQL,
  personAllergiesParams,
} from "../../../../people/queries";
import { useRecordScreenProtection } from "../../../../security/use-record-protection";
import { mayRecordFor } from "../../../../sync/write-scope";
import { useWriteScope } from "../../../../sync/write-scope-store";

/**
 * A person's record in Care mode: the point-of-care header (HZ-001), what to record (note,
 * chart, body map mark), the care plan and risk assessments (read only), allergies, entries the
 * server refused, and recent entries with their upload state, kept for the offline window.
 */
export default function PersonScreen() {
  useRecordScreenProtection("person-record");
  const theme = useTheme();
  const router = useRouter();
  const vault = useVault();
  const { personId, task } = useLocalSearchParams<{
    personId: string;
    task?: string;
  }>();
  const id = typeof personId === "string" ? personId : "";
  // Came from the round to record the entry a task asks for: the new entry answers that task,
  // and only the first: once one is saved here, later entries are not tagged with it (HZ-029).
  // Only a task this device holds for this person, still open: never one named by a link alone,
  // and never its words from the route (#123 security review, M2).
  const tenantId = useTenantId();
  const roundTask = useRoundTaskFor(id, typeof task === "string" && task ? task : null, {
    includeAnswered: true,
  });
  const askedTask = roundTask?.id ?? null;
  const evidenceParams = useMemo(() => [tenantId, askedTask ?? ""], [tenantId, askedTask]);
  const { data: evidence } = useQuery<{ count: number }>(TASK_EVIDENCE_SQL, evidenceParams);
  // Answered once an entry for it is saved here, and still after that entry uploads and its
  // synced copy no longer names the task (#123 clinical review, M1).
  const taskAnswered =
    askedTask !== null && (Number(evidence[0]?.count ?? 0) > 0 || roundTask?.answered === true);
  const forTask = taskAnswered ? null : askedTask;
  const { person } = useCarePerson(id);
  // Recording is offered only where the user's care.note.write reaches the person, as the sync
  // token says, per person for those assigned to them; the API decides either way (review rounds
  // 2 and 3, C2-M3 and C3-M2). With no scope known (one that could not be kept or read), nothing
  // is offered and the screen says how to fix it (review round 5). A demo build never syncs, has
  // no token and keeps everything on the phone: it records about anyone it shows, as before.
  const writeScope = useWriteScope();
  const mayRecord = person
    ? appEnv.demoMode || mayRecordFor({ id, locationId: person.locationId }, writeScope)
    : false;

  const params = useMemo(() => [tenantId, id], [tenantId, id]);
  const allergyParams = useMemo(() => personAllergiesParams(tenantId, id), [tenantId, id]);
  const chartParams = useMemo(() => observationParams(tenantId, id, null), [tenantId, id]);
  const { data: allergies } = useQuery<AllergyRow>(PERSON_ALLERGIES_SQL, allergyParams);
  const { data: notes } = useQuery<NoteRow>(NOTES_SQL, params);
  const { data: observations } = useQuery<ObservationRow>(OBSERVATIONS_SQL, chartParams);
  const { data: marks } = useQuery<MarkRow>(MARKS_SQL, params);
  const entries = useMemo(
    () => recentEntries(notes, observations, marks, appEnv.demoMode),
    [notes, observations, marks],
  );

  const go = useCallback(
    (
      screen: "note" | "chart" | "body-map" | "care-plan" | "risks",
      extra: Record<string, string> = {},
    ) =>
      router.push({
        pathname: `/people/[personId]/${screen}`,
        params: { personId: id, ...(forTask && !extra.correct ? { task: forTask } : {}), ...extra },
      }),
    [router, id, forTask],
  );
  const correct = useCallback(
    (item: EntryItem) => {
      if (item.table === "care_note") go("note", { correct: item.id });
      else if (item.table === "body_map_mark") go("body-map", { correct: item.id });
      else go("chart", { correct: item.id, chart: item.chart ?? "" });
    },
    [go],
  );

  return (
    <Screen testID="person-screen">
      <Stack.Screen options={{ title: person?.displayName ?? t("mobile.person.title") }} />
      <FlatList
        testID="person-entries"
        data={person ? entries : []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: theme.space[2] }}>
            <EntryRow item={item} onCorrect={mayRecord ? correct : undefined} />
          </View>
        )}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
        ListHeaderComponent={
          <View style={{ padding: theme.space[2], gap: theme.space[2] }}>
            <CarePersonHeader personId={id} />
            {person ? (
              <>
                <Card title={t("mobile.person.actions")}>
                  {askedTask && mayRecord ? (
                    <Text testID="person-for-task">
                      {t(taskAnswered ? "mobile.person.forTaskRecorded" : "mobile.person.forTask", {
                        title: roundTask?.title ?? "",
                      })}
                    </Text>
                  ) : null}
                  {mayRecord ? (
                    <>
                      <Button
                        label={t("mobile.person.writeNote")}
                        onPress={() => go("note")}
                        testID="action-note"
                      />
                      <Button
                        label={t("mobile.person.recordChart")}
                        onPress={() => go("chart")}
                        testID="action-chart"
                      />
                      <Button
                        label={t("mobile.person.bodyMap")}
                        variant="secondary"
                        onPress={() => go("body-map")}
                        testID="action-body-map"
                      />
                    </>
                  ) : (
                    <Text tone="secondary" testID="person-read-only">
                      {writeScope === null
                        ? t("mobile.person.writeScopeUnavailable")
                        : t("mobile.person.readOnly")}
                    </Text>
                  )}
                  <Button
                    label={t("mobile.person.carePlan")}
                    variant="secondary"
                    onPress={() => go("care-plan")}
                    testID="action-care-plan"
                  />
                  <Button
                    label={t("mobile.person.risks")}
                    variant="secondary"
                    onPress={() => go("risks")}
                    testID="action-risks"
                  />
                </Card>
                <UploadIssues personId={id} />
                {allergies.length > 0 ? (
                  <Card title={t("mobile.person.allergies")} testID="allergy-list">
                    {allergies.map((allergy) => (
                      <View key={allergy.id} accessible style={{ gap: theme.space[0.5] }}>
                        <Text emphasis selectable={false}>
                          {allergy.substance ?? t("mobile.person.allergySubstanceMissing")}
                        </Text>
                        <Text variant="bodyDense" tone="secondary" selectable={false}>
                          {[
                            allergy.reaction
                              ? t("mobile.person.allergyReaction", { reaction: allergy.reaction })
                              : null,
                            allergy.severity
                              ? t("mobile.person.allergySeverity", { severity: allergy.severity })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(". ") || t("mobile.person.allergyNoDetails")}
                        </Text>
                      </View>
                    ))}
                  </Card>
                ) : null}
                <View style={{ gap: theme.space[0.5] }} testID="recent-entries">
                  <Text variant="eyebrow" accessibilityRole="header">
                    {t("mobile.person.recent")}
                  </Text>
                  {vault.offlineWindowDays !== null && !appEnv.demoMode ? (
                    <Text variant="bodyDense" tone="secondary">
                      {t("mobile.sync.window", { days: vault.offlineWindowDays })}
                    </Text>
                  ) : null}
                  {entries.length === 0 ? (
                    <Text tone="secondary">{t("mobile.person.noEntries")}</Text>
                  ) : null}
                </View>
              </>
            ) : null}
          </View>
        }
        ListFooterComponent={<View style={{ height: theme.space[4] }} />}
      />
    </Screen>
  );
}
