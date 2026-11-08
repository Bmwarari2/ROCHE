import { Button, ListItem, PersonFlags, StatusChip, Text, useTheme } from "@harbour/ui-native";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { AccessibilityInfo, FlatList, View } from "react-native";
import { useSession } from "../../../app-state/session";
import { Screen } from "../../../components/Screen";
import { StatusLine } from "../../../components/StatusLine";
import { UploadIssues } from "../../../components/UploadIssues";
import { t } from "../../../i18n/t";
import { useMedicinesRound } from "../../../medicines/hooks";
import { doseSlots } from "../../../medicines/round";
import {
  communicationNeedsCount,
  DOSE_STATUS,
  gateWords,
  personName,
  ukDateWords,
} from "../../../medicines/view";
import { useRecordScreenProtection } from "../../../security/use-record-protection";

/**
 * The medicines round on the phone (slice 69; HZ-003, HZ-004): the doses on this phone slot by
 * slot, late first within each, every dose with its state as an icon and a word. Nothing is
 * offered on an untrusted device, before a complete sync or without the medicines figures; the
 * reason is said instead. The needs-attention list sits above, so a dose Harbour did not take is
 * never out of sight (HZ-006).
 */
export default function MedicinesRoundScreen() {
  useRecordScreenProtection("medicines");
  const theme = useTheme();
  const router = useRouter();
  const { gate, rounds, people, loading } = useMedicinesRound();
  const { me } = useSession();
  // The nurse in charge (medicines.record.manage) reviews doses recorded on two phones.
  const manages = (me?.permissions ?? []).includes("medicines.record.manage");
  const blocked = gateWords(gate);
  const slots = doseSlots(rounds);
  const unreadable = rounds.flatMap((r) => r.unreadable);
  const unreadableWords =
    unreadable.length > 0 ? t("mobile.meds.unreadable", { list: unreadable.join(", ") }) : null;
  // Announced when it changes, on iOS too (WCAG 4.1.3).
  useEffect(() => {
    if (blocked) AccessibilityInfo.announceForAccessibility(blocked);
  }, [blocked]);
  useEffect(() => {
    if (unreadableWords) AccessibilityInfo.announceForAccessibility(unreadableWords);
  }, [unreadableWords]);
  return (
    <Screen testID="medicines-round">
      <UploadIssues />
      <View style={{ paddingHorizontal: theme.space[2], paddingTop: theme.space[1] }}>
        <Button
          label={t("mobile.meds.pinsLink")}
          accessibilityHint={t("mobile.meds.pinsLinkHint")}
          variant="secondary"
          onPress={() => router.push("/medicines/pins")}
          testID="open-pins"
        />
        {manages ? (
          <Button
            label={t("mobile.meds.conflictsLink")}
            accessibilityHint={t("mobile.meds.conflictsLinkHint")}
            variant="secondary"
            onPress={() => router.push("/medicines/conflicts")}
            testID="open-conflicts"
          />
        ) : null}
      </View>
      {blocked ? (
        <View style={{ padding: theme.space[2] }}>
          <StatusLine tone="warning" testID="medicines-blocked">
            {blocked}
          </StatusLine>
        </View>
      ) : (
        <FlatList
          data={slots}
          keyExtractor={(s) => `${s.date} ${s.time}`}
          ListHeaderComponent={
            unreadable.length > 0 ? (
              <View style={{ padding: theme.space[2] }}>
                <StatusLine tone="danger" testID="medicines-unreadable">
                  {t("mobile.meds.unreadable", { list: unreadable.join(", ") })}
                </StatusLine>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <Text tone="secondary" style={{ padding: theme.space[2] }} testID="medicines-empty">
              {loading ? t("mobile.round.loading") : t("mobile.meds.none")}
            </Text>
          }
          renderItem={({ item: slot }) => (
            <View style={{ paddingBottom: theme.space[1.5] }}>
              <Text
                variant="callout"
                accessibilityRole="header"
                style={{ paddingHorizontal: theme.space[2], paddingVertical: theme.space[1] }}
              >
                {t("mobile.meds.slot", { date: ukDateWords(slot.date), time: slot.time })}
              </Text>
              {slot.doses.map((d) => {
                const person = people.get(d.personId);
                const name = person ? personName(person) : t("mobile.meds.personNotOnPhone");
                return (
                  <ListItem
                    key={`${d.entryId}:${d.dueAt}`}
                    title={`${name}: ${d.productName}`}
                    subtitle={[d.doseInWords, d.timeCritical ? t("mobile.meds.timeCritical") : null]
                      .filter(Boolean)
                      .join(". ")}
                    accessories={
                      <View style={{ gap: theme.space[0.5], alignItems: "flex-end" }}>
                        <StatusChip status={DOSE_STATUS[d.state]} label={d.stateInWords} />
                        {person ? (
                          <PersonFlags
                            allergyStatus={person.allergy_status}
                            allergyCount={person.allergy_count}
                            communicationNeedsCount={communicationNeedsCount(
                              person.communication_needs,
                            )}
                            context="list"
                            testID={`dose-${d.entryId}-flags`}
                          />
                        ) : null}
                      </View>
                    }
                    onPress={() =>
                      router.push({
                        pathname: "/medicines/[personId]",
                        params: { personId: d.personId },
                      })
                    }
                    accessibilityHint={t("mobile.meds.openPersonHint", { person: name })}
                    showChevron
                    testID={`dose-${d.entryId}`}
                  />
                );
              })}
            </View>
          )}
        />
      )}
    </Screen>
  );
}
