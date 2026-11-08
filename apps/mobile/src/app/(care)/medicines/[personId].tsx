import { Button, ListItem, StatusChip, Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSession } from "../../../app-state/session";
import { useTenantId } from "../../../care/hooks";
import { CarePersonHeader } from "../../../components/CarePersonHeader";
import { CorrectionPanel } from "../../../components/CorrectionPanel";
import { type DoseChoice, DoseRecordPanel } from "../../../components/DoseRecordPanel";
import { Screen } from "../../../components/Screen";
import { StatusLine } from "../../../components/StatusLine";
import { t } from "../../../i18n/t";
import { mayCorrectOnPhone } from "../../../medicines/correction";
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
  const { me } = useSession();
  const { gate, rounds, people, administrations } = useMedicinesRound();
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
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const person = personId ? people.get(personId) : undefined;
  const name = person ? personName(person) : t("mobile.meds.personNotOnPhone");
  const allergy = allergyLine(person?.allergy_status ?? null, allergies);
  const round = rounds.find((r) => r.personId === personId);
  const blocked = gateWords(gate);
  // The person's records of the last day that nothing has corrected yet, newest first, to correct.
  const recent = useMemo(() => {
    const corrected = new Set(administrations.map((a) => a.supersedes_id).filter(Boolean));
    const since = Date.now() - 24 * 3_600_000;
    return administrations
      .filter(
        (a) =>
          a.person_id === personId &&
          !corrected.has(a.id) &&
          a.given_at !== null &&
          new Date(a.given_at).getTime() >= since,
      )
      .sort((a, b) => (b.given_at ?? "").localeCompare(a.given_at ?? ""));
  }, [administrations, personId]);

  const choose = (
    entryId: string,
    productName: string,
    doseInWords: string,
    dueAt: string | null,
    mayGive: boolean,
    time: string | null,
    prn: {
      nextAllowedAt: string | null;
      lastDoseNotOnDevice: boolean;
      remaining: number | null;
    } | null = null,
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
      // Not yet known counts as a controlled drug (slice 70 clinical review, L5).
      controlledDrug: !round || !row || round.controlledDrugIds.has(entryId),
      allergyWords: allergy.words,
      nextAllowedAt: prn?.nextAllowedAt ? new Date(prn.nextAllowedAt) : null,
      lastDoseNotOnDevice: prn?.lastDoseNotOnDevice ?? false,
      prnRemaining: prn?.remaining ?? null,
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
        ) : correcting ? (
          (() => {
            const rec = recent.find((r) => r.id === correcting);
            const med = meds.find((m) => m.id === rec?.medication_id);
            return rec && rec.given_at ? (
              <CorrectionPanel
                personId={personId ?? ""}
                personName={name}
                productName={med?.product_name ?? ""}
                original={{
                  id: rec.id,
                  entryId: rec.medication_id,
                  dueAt: rec.due_at,
                  givenAt: rec.given_at,
                  outcome: rec.outcome ?? "",
                  quantity: rec.quantity,
                  unitCode: rec.unit_code,
                  synced: rec.request === null,
                }}
                unitName={
                  times.find((x) => x.medication_id === rec.medication_id)?.unit_name ?? null
                }
                controlledDrug={med ? med.cd_schedule != null : true}
                onDone={(ok) => {
                  setCorrecting(null);
                  setSaved(ok);
                }}
              />
            ) : (
              <Button
                label={t("mobile.meds.stop")}
                variant="secondary"
                onPress={() => setCorrecting(null)}
              />
            );
          })()
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
                    remaining: w.remaining,
                  })
                }
                testID={`person-prn-${w.entryId}`}
              />
            ))}
            {recent.length > 0 ? (
              <Text variant="callout" accessibilityRole="header">
                {t("mobile.meds.recentHeading")}
              </Text>
            ) : null}
            {recent.map((r) => {
              const med = meds.find((m) => m.id === r.medication_id);
              // Said before anyone starts: what cannot be corrected here, and why (WCAG 3.3.4).
              const blockedWhy =
                r.request !== null
                  ? t("mobile.meds.correctionProblem", { problem: "not_synced" })
                  : med?.cd_schedule
                    ? t("mobile.meds.correctionProblem", { problem: "controlled_drug_on_web" })
                    : !mayCorrectOnPhone(r, me ?? {})
                      ? t("mobile.meds.correctionProblem", { problem: "not_yours" })
                      : null;
              return (
                <ListItem
                  key={r.id}
                  title={med?.product_name ?? t("mobile.meds.medicineNotOnPhone")}
                  subtitle={[
                    t("mobile.meds.outcomeName", { outcome: r.outcome ?? "other" }),
                    r.given_at ? ukInstantWords(r.given_at) : null,
                    r.request === null ? null : t("mobile.meds.notSyncedYet"),
                    blockedWhy ?? t("mobile.meds.correctAction"),
                  ]
                    .filter(Boolean)
                    .join(". ")}
                  onPress={blockedWhy ? undefined : () => setCorrecting(r.id)}
                  accessibilityHint={blockedWhy ? undefined : t("mobile.meds.correctHint")}
                  testID={`recent-${r.id}`}
                />
              );
            })}
            {round && round.doses.length === 0 && round.whenRequired.length === 0 ? (
              <Text tone="secondary">{t("mobile.meds.noneForPerson")}</Text>
            ) : null}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
