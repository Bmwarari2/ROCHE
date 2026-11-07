import { ListItem, StatusChip, Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useTenantId } from "../../../care/hooks";
import { CarePersonHeader } from "../../../components/CarePersonHeader";
import { type DoseChoice, DoseRecordPanel } from "../../../components/DoseRecordPanel";
import { Screen } from "../../../components/Screen";
import { StatusLine } from "../../../components/StatusLine";
import { t } from "../../../i18n/t";
import { DMD_SUBSET_FAILED_META_ID, DMD_SUBSET_META_ID } from "../../../medicines/dmd-subset";
import { useMedicinesRound } from "../../../medicines/hooks";
import { ROUND_MEDICATION_SQL, ROUND_SCHEDULE_SQL } from "../../../medicines/queries";
import type { MedicationLocalRow, ScheduleLocalRow } from "../../../medicines/round";
import {
  allergyLine,
  DOSE_STATUS,
  dmdSubsetLine,
  gateWords,
  personName,
  ukDateWords,
  ukInstantWords,
} from "../../../medicines/view";
import {
  type AllergyRow,
  PERSON_ALLERGIES_SQL,
  personAllergiesParams,
} from "../../../people/queries";
import { useRecordScreenProtection } from "../../../security/use-record-protection";

function prnUnit(row: MedicationLocalRow | undefined): {
  unitCode: string | null;
  unitName: string | null;
  quantity: number | null;
} {
  try {
    const dose = JSON.parse(row?.prn_dose ?? "null") as {
      kind?: string;
      quantity?: number;
      unit?: { code?: string; name?: string };
    } | null;
    return {
      unitCode: dose?.unit?.code ?? null,
      unitName: dose?.unit?.name ?? null,
      quantity: dose?.kind === "amount" ? (dose.quantity ?? null) : null,
    };
  } catch {
    return { unitCode: null, unitName: null, quantity: null };
  }
}

/**
 * One person's medicines on the round (slice 69): the point-of-care header with their photo, name,
 * date of birth and allergies (HZ-001, HZ-007), their doses in this slot and the when-required
 * medicines with when each was last given and how much is left in 24 hours (HZ-004). Choosing one
 * opens the record panel.
 */
export default function PersonMedicinesScreen() {
  useRecordScreenProtection("medicines-person");
  const theme = useTheme();
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const tenantId = useTenantId();
  const { gate, rounds, people } = useMedicinesRound();
  const params = useMemo(() => [tenantId], [tenantId]);
  const { data: meds } = useQuery<MedicationLocalRow>(ROUND_MEDICATION_SQL, params);
  const { data: times } = useQuery<ScheduleLocalRow>(ROUND_SCHEDULE_SQL, params);
  const allergyParams = useMemo(
    () => personAllergiesParams(tenantId, personId ?? ""),
    [tenantId, personId],
  );
  const { data: allergies } = useQuery<AllergyRow>(PERSON_ALLERGIES_SQL, allergyParams);
  const metaParams = useMemo(() => [DMD_SUBSET_META_ID, DMD_SUBSET_FAILED_META_ID], []);
  const { data: dmdMeta } = useQuery<{ id: string; value: string }>(
    "SELECT id, value FROM sync_meta WHERE id IN (?, ?)",
    metaParams,
  );
  const dmdLine = dmdSubsetLine(
    dmdMeta.find((m) => m.id === DMD_SUBSET_META_ID)?.value ?? null,
    dmdMeta.find((m) => m.id === DMD_SUBSET_FAILED_META_ID)?.value ?? null,
  );
  const [choice, setChoice] = useState<DoseChoice | null>(null);
  const [saved, setSaved] = useState(false);
  const person = personId ? people.get(personId) : undefined;
  const name = person ? personName(person) : t("mobile.meds.personNotOnPhone");
  const allergy = allergyLine(person?.allergy_status ?? null, allergies);
  const round = rounds.find((r) => r.personId === personId);
  const blocked = gateWords(gate);

  const choose = (
    entryId: string,
    productName: string,
    doseInWords: string,
    dueAt: string | null,
    mayGive: boolean,
    time: string | null,
    prn: { nextAllowedAt: string | null; lastDoseNotOnDevice: boolean } | null = null,
  ) => {
    const row = meds.find((m) => m.id === entryId);
    const slot = time
      ? times.find((s) => s.medication_id === entryId && s.time === time)
      : undefined;
    const unit = slot
      ? {
          unitCode: slot.unit_code,
          unitName: slot.unit_name,
          quantity: slot.dose_kind === "amount" ? Number(slot.quantity) : null,
        }
      : prnUnit(row);
    setSaved(false);
    setChoice({
      personId: personId ?? "",
      personName: name,
      entryId,
      productName,
      doseInWords,
      dueAt,
      vmpId: row?.vmp_id ?? "",
      ampId: row?.amp_id ?? null,
      ...unit,
      mayGive,
      controlledDrug: round?.controlledDrugIds.has(entryId) ?? false,
      allergyWords: allergy.words,
      nextAllowedAt: prn?.nextAllowedAt ? new Date(prn.nextAllowedAt) : null,
      lastDoseNotOnDevice: prn?.lastDoseNotOnDevice ?? false,
    });
  };

  return (
    <Screen testID="medicines-person">
      <Stack.Screen options={{ title: t("mobile.meds.personTitleFor", { person: name }) }} />
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[1.5] }}>
        {personId ? <CarePersonHeader personId={personId} /> : null}
        {allergy.warning ? (
          <StatusLine tone="warning" testID="person-allergy-line">
            {allergy.words}
          </StatusLine>
        ) : (
          <Text tone="secondary" testID="person-allergy-line">
            {allergy.words}
          </Text>
        )}
        {saved ? (
          <StatusLine tone="success" testID="dose-saved">
            {t("mobile.meds.saved")}
          </StatusLine>
        ) : null}
        {blocked ? (
          <StatusLine tone="warning" testID="medicines-blocked">
            {blocked}
          </StatusLine>
        ) : choice ? (
          <DoseRecordPanel
            dose={choice}
            dmdLine={dmdLine}
            onDone={(ok) => {
              setChoice(null);
              setSaved(ok);
            }}
          />
        ) : (
          <View style={{ gap: theme.space[1] }}>
            {(round?.doses.length ?? 0) > 0 ? (
              <Text variant="callout" accessibilityRole="header">
                {t("mobile.meds.scheduledHeading")}
              </Text>
            ) : null}
            {(round?.doses ?? []).map((d) => (
              <ListItem
                key={`${d.entryId}:${d.dueAt}`}
                title={d.productName}
                subtitle={[
                  t("mobile.meds.dueAt", { date: ukDateWords(d.date), time: d.time }),
                  d.doseInWords,
                  allergy.words,
                  d.reviewInWords,
                  d.entryStatus.notice,
                  ...d.notices,
                ]
                  .filter(Boolean)
                  .join(". ")}
                accessories={<StatusChip status={DOSE_STATUS[d.state]} label={d.stateInWords} />}
                onPress={
                  d.state === "recorded"
                    ? undefined
                    : () =>
                        choose(
                          d.entryId,
                          d.productName,
                          d.doseInWords,
                          d.dueAt,
                          d.entryStatus.mayGive,
                          d.time,
                        )
                }
                testID={`person-dose-${d.entryId}`}
              />
            ))}
            {(round?.whenRequired.length ?? 0) > 0 ? (
              <Text variant="callout" accessibilityRole="header">
                {t("mobile.meds.whenRequiredHeading")}
              </Text>
            ) : null}
            {(round?.whenRequired ?? []).map((w) => (
              <ListItem
                key={w.entryId}
                title={t("mobile.meds.whenRequired", { medicine: w.productName })}
                subtitle={[
                  w.lastGiven
                    ? t("mobile.meds.lastGiven", {
                        at: ukInstantWords(w.lastGiven.at),
                        synced: String(w.lastGiven.synced),
                      })
                    : t("mobile.meds.notGivenOnPhone"),
                  w.maxPer24Hours === null
                    ? null
                    : t("mobile.meds.in24Hours", {
                        given: w.givenInLast24Hours,
                        max: w.maxPer24Hours,
                      }),
                  w.nextAllowedAt
                    ? t("mobile.meds.nextAllowed", { at: ukInstantWords(w.nextAllowedAt) })
                    : null,
                  allergy.words,
                  ...w.notices,
                ]
                  .filter(Boolean)
                  .join(". ")}
                onPress={() =>
                  choose(w.entryId, w.productName, "", null, w.remaining !== 0, null, {
                    nextAllowedAt: w.nextAllowedAt,
                    lastDoseNotOnDevice: w.lastDoseNotOnDevice,
                  })
                }
                testID={`person-prn-${w.entryId}`}
              />
            ))}
            {round && round.doses.length === 0 && round.whenRequired.length === 0 ? (
              <Text tone="secondary">{t("mobile.meds.noneForPerson")}</Text>
            ) : null}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
