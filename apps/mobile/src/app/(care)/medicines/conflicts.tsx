import { Button, Text, useTheme } from "@harbour/ui-native";
import { usePowerSync } from "@powersync/react";
import { useCallback, useEffect, useState } from "react";
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
} from "../../../medicines/conflicts";
import { useMedicinesRound } from "../../../medicines/hooks";
import { personName, ukInstantWords } from "../../../medicines/view";
import { useRecordScreenProtection } from "../../../security/use-record-protection";

function recordWords(r: ConflictRecord): string {
  return [
    t("mobile.meds.outcomeName", { outcome: r.outcome }),
    r.quantity === null ? null : String(r.quantity),
    r.givenAt ? ukInstantWords(r.givenAt) : null,
  ]
    .filter(Boolean)
    .join(", ");
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
          <Text tone="secondary">{t("mobile.round.loading")}</Text>
        ) : conflicts.length === 0 ? (
          <Text tone="secondary">{t("mobile.meds.conflictNone")}</Text>
        ) : (
          conflicts.map((c) => {
            const person = people.get(c.personId);
            return (
              <Card
                key={c.id}
                title={person ? personName(person) : t("mobile.meds.personNotOnPhone")}
                testID={`conflict-${c.id}`}
              >
                <View style={{ gap: theme.space[1] }}>
                  <Text>{t("mobile.meds.conflictDue", { at: ukInstantWords(c.dueAt) })}</Text>
                  <Text>
                    {t("mobile.meds.conflictStanding", { record: recordWords(c.standing) })}
                  </Text>
                  <Text>
                    {t("mobile.meds.conflictUploaded", { record: recordWords(c.uploaded) })}
                  </Text>
                  <StatusLine tone={sameDose(c) ? "success" : "warning"}>
                    {sameDose(c) ? t("mobile.meds.conflictSame") : t("mobile.meds.conflictDiffer")}
                  </StatusLine>
                  <TextField
                    label={t("mobile.meds.conflictNote")}
                    value={notes[c.id] ?? ""}
                    onChangeText={(v) => setNotes((n) => ({ ...n, [c.id]: v }))}
                    maxLength={2000}
                  />
                  <Button
                    label={t("mobile.meds.conflictFirstStands")}
                    variant="secondary"
                    onPress={() => void resolve(c, "first_stands")}
                  />
                  <Button
                    label={t("mobile.meds.conflictBothGiven")}
                    accessibilityHint={t("mobile.meds.conflictBothGivenHint")}
                    variant="destructive"
                    onPress={() => void resolve(c, "both_given")}
                  />
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
