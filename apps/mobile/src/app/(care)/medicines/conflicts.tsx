import { Button, PersonFlags, Text, useTheme } from "@harbour/ui-native";
import { usePowerSync, useQuery } from "@powersync/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, ScrollView, View } from "react-native";
import { useSession } from "../../../app-state/session";
import { platformFetch } from "../../../auth/clients";
import { useTenantId } from "../../../care/hooks";
import { Card } from "../../../components/Card";
import { Screen } from "../../../components/Screen";
import { StatusLine } from "../../../components/StatusLine";
import { TextField } from "../../../components/TextField";
import { appEnv } from "../../../config/app-env";
import { t } from "../../../i18n/t";
import {
  type ApiOptions,
  type ConflictRecord,
  type ConflictView,
  fetchConflicts,
  type ResolveOutcome,
  resolveConflict,
  sameDose,
  sameRecorder,
} from "../../../medicines/conflicts";
import { useMedicinesRound } from "../../../medicines/hooks";
import { ROUND_MEDICATION_SQL, ROUND_SCHEDULE_SQL } from "../../../medicines/queries";
import type { MedicationLocalRow, ScheduleLocalRow } from "../../../medicines/round";
import { communicationNeedsCount, personName, ukInstantWords } from "../../../medicines/view";
import { useRecordScreenProtection } from "../../../security/use-record-protection";

function recordWords(r: ConflictRecord, unit: string | null): string {
  return t("mobile.meds.conflictRecord", {
    outcome: r.outcome,
    quantity: r.quantity === null ? "none" : String(r.quantity),
    unit: unit ?? r.unitCode ?? "",
    at: r.givenAt ? ukInstantWords(r.givenAt) : "none",
  });
}

/**
 * Doses recorded on two phones, for the nurse in charge (slice 70; medicines.md 15.4; HZ-004):
 * each with both records in words, and whether they agree. Online: read from and resolved through
 * Harbour. The same dose sent twice, or given twice (a medication incident is raised); a correction
 * of the MAR is made on the web.
 */
export default function MedicinesConflictsScreen() {
  useRecordScreenProtection("medicines-conflicts");
  const theme = useTheme();
  const db = usePowerSync();
  const tenantId = useTenantId();
  const { me, token } = useSession();
  const { people } = useMedicinesRound();
  const [conflicts, setConflicts] = useState<ConflictView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [words, setWords] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{ id: string; outcome: ResolveOutcome } | null>(
    null,
  );
  const medParams = useMemo(() => [tenantId], [tenantId]);
  const { data: meds } = useQuery<MedicationLocalRow>(ROUND_MEDICATION_SQL, medParams);
  const { data: times } = useQuery<ScheduleLocalRow>(ROUND_SCHEDULE_SQL, medParams);

  const options = useCallback(async (): Promise<ApiOptions | null> => {
    if (!token || !tenantId) return null;
    return {
      apiUrl: appEnv.apiUrl,
      fetch: platformFetch,
      token,
      tenantId,
      deviceId: await db.getClientId(),
    };
  }, [db, token, tenantId]);

  const load = useCallback(async () => {
    const o = await options();
    if (!o) return;
    const all: ConflictView[] = [];
    let ok = true;
    for (const location of me?.locations ?? []) {
      const got = await fetchConflicts(o, location.id);
      if (!got) ok = false;
      else all.push(...got.conflicts);
    }
    setFailed(!ok);
    setConflicts(all);
  }, [options, me?.locations]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (c: ConflictView, outcome: ResolveOutcome) => {
    const o = await options();
    if (!o) return;
    const r = await resolveConflict(o, c.id, outcome, notes[c.id] ?? "");
    const said = r.ok
      ? t("mobile.meds.conflictResolved")
      : (r.detail ?? t("mobile.meds.conflictFailed"));
    setWords((w) => ({ ...w, [c.id]: said }));
    AccessibilityInfo.announceForAccessibility(said);
    if (r.ok) void load();
  };

  return (
    <Screen testID="medicines-conflicts">
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[1.5] }}>
        <Text>{t("mobile.meds.conflictIntro")}</Text>
        {failed ? <StatusLine tone="warning">{t("mobile.meds.conflictOffline")}</StatusLine> : null}
        {conflicts === null ? (
          <Text tone="secondary" accessibilityLiveRegion="polite">
            {t("mobile.round.loading")}
          </Text>
        ) : conflicts.length === 0 ? (
          <Text tone="secondary">{t("mobile.meds.conflictNone")}</Text>
        ) : (
          conflicts.map((c) => {
            const person = people.get(c.personId);
            const medicine = meds.find((m) => m.id === c.entryId)?.product_name ?? null;
            const unit = times.find((x) => x.medication_id === c.entryId)?.unit_name ?? null;
            const asking = confirming?.id === c.id ? confirming.outcome : null;
            return (
              <Card
                key={c.id}
                title={t("mobile.meds.conflictCardTitle", {
                  person: person ? personName(person) : t("mobile.meds.personNotOnPhone"),
                  medicine: medicine ?? t("mobile.meds.medicineNotOnPhone"),
                })}
                testID={`conflict-${c.id}`}
              >
                <View style={{ gap: theme.space[1] }}>
                  {person ? (
                    <PersonFlags
                      allergyStatus={person.allergy_status}
                      allergyCount={person.allergy_count}
                      communicationNeedsCount={communicationNeedsCount(person.communication_needs)}
                      context="list"
                      testID={`conflict-${c.id}-flags`}
                    />
                  ) : null}
                  <Text>{t("mobile.meds.conflictDue", { at: ukInstantWords(c.dueAt) })}</Text>
                  <Text>
                    {t("mobile.meds.conflictStanding", { record: recordWords(c.standing, unit) })}
                  </Text>
                  <Text>
                    {t("mobile.meds.conflictUploaded", { record: recordWords(c.uploaded, unit) })}
                  </Text>
                  <StatusLine tone="warning">
                    {sameDose(c) ? t("mobile.meds.conflictSame") : t("mobile.meds.conflictDiffer")}
                  </StatusLine>
                  <Text>
                    {sameRecorder(c)
                      ? t("mobile.meds.conflictSameRecorder")
                      : t("mobile.meds.conflictTwoRecorders")}
                  </Text>
                  <TextField
                    label={t("mobile.meds.conflictNote")}
                    hint={t("mobile.meds.conflictNoteHint")}
                    value={notes[c.id] ?? ""}
                    onChangeText={(v) => setNotes((n) => ({ ...n, [c.id]: v }))}
                    maxLength={2000}
                  />
                  {asking ? (
                    // One more step before a decision is sent: what it does, in words (WCAG 3.3.4).
                    <View style={{ gap: theme.space[1] }} testID={`conflict-${c.id}-confirm`}>
                      <StatusLine tone="warning">
                        {t("mobile.meds.conflictConfirm", { outcome: asking })}
                      </StatusLine>
                      <Button
                        label={t("mobile.meds.conflictConfirmButton", { outcome: asking })}
                        variant={asking === "both_given" ? "destructive" : "primary"}
                        onPress={() => {
                          setConfirming(null);
                          void resolve(c, asking);
                        }}
                      />
                      <Button
                        label={t("mobile.meds.conflictKeepReviewing")}
                        variant="secondary"
                        onPress={() => setConfirming(null)}
                      />
                    </View>
                  ) : (
                    <>
                      <Button
                        label={t("mobile.meds.conflictFirstStands")}
                        variant="secondary"
                        disabled={!(notes[c.id] ?? "").trim()}
                        onPress={() => setConfirming({ id: c.id, outcome: "first_stands" })}
                      />
                      <Button
                        label={t("mobile.meds.conflictBothGiven")}
                        accessibilityHint={t("mobile.meds.conflictBothGivenHint")}
                        variant="destructive"
                        disabled={!(notes[c.id] ?? "").trim()}
                        onPress={() => setConfirming({ id: c.id, outcome: "both_given" })}
                      />
                    </>
                  )}
                  <Text tone="secondary">{t("mobile.meds.conflictCorrectOnWeb")}</Text>
                  {words[c.id] ? <Text accessibilityLiveRegion="polite">{words[c.id]}</Text> : null}
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}
