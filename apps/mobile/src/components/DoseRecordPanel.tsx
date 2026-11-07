import {
  type AdministrationOutcome,
  checkPack,
  OUTCOME_REASONS,
  PACK_OVERRIDE_REASONS,
  type PackCheck,
  type PackOverrideReason,
  parsePackBarcode,
} from "@harbour/domain";
import { Button, Text, useTheme } from "@harbour/ui-native";
import { usePowerSync } from "@powersync/react";
import { useState } from "react";
import { View } from "react-native";
import { useSession } from "../app-state/session";
import { useTenantId } from "../care/hooks";
import { t } from "../i18n/t";
import { useRecordDose } from "../medicines/hooks";
import { DEVICE_GTINS_SQL, DEVICE_PRODUCTS_SQL } from "../medicines/queries";
import {
  type PackEvidence,
  PHONE_OUTCOMES,
  type RecordProblem,
  recordProblems,
} from "../medicines/record";
import { ukToday } from "../medicines/round";
import { packCheckWords } from "../medicines/view";
import { newEntryId } from "../platform/ids";
import { PackScanner } from "./PackScanner";
import { TextField } from "./TextField";

export interface DoseChoice {
  readonly personId: string;
  readonly personName: string;
  readonly entryId: string;
  readonly productName: string;
  readonly doseInWords: string;
  /** ISO, or null for a when-required dose. */
  readonly dueAt: string | null;
  readonly vmpId: string;
  readonly ampId: string | null;
  readonly unitCode: string | null;
  readonly unitName: string | null;
  /** The prescribed amount, when the dose is one amount. */
  readonly quantity: number | null;
  readonly mayGive: boolean;
  readonly controlledDrug: boolean;
  /** The allergy line, shown beside the medicine (HZ-007). */
  readonly allergyWords: string;
}

/**
 * Recording one dose on the round (slice 69; ADR-0081; HZ-001, HZ-004): the allergy line beside
 * the medicine, positive identification by photo, the pack scanned and matched (or why not), the
 * outcome and its reason. What stops the record is said in words before Save does anything.
 */
export function DoseRecordPanel({
  dose,
  onDone,
}: {
  readonly dose: DoseChoice;
  readonly onDone: (saved: boolean) => void;
}) {
  const theme = useTheme();
  const db = usePowerSync();
  const tenantId = useTenantId();
  const { me } = useSession();
  const record = useRecordDose();
  const [outcome, setOutcome] = useState<AdministrationOutcome | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [identity, setIdentity] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pack, setPack] = useState<PackEvidence | null>(null);
  const [scanWords, setScanWords] = useState<string | null>(null);
  const [overrideCode, setOverrideCode] = useState<PackOverrideReason | null>(null);
  const [overrideNote, setOverrideNote] = useState("");
  const [amount, setAmount] = useState(dose.quantity === null ? "" : String(dose.quantity));
  const [problems, setProblems] = useState<readonly RecordProblem[]>([]);
  const [saving, setSaving] = useState(false);

  const scanned = async (raw: string) => {
    setScanning(false);
    const scan = parsePackBarcode(raw);
    if (!scan) {
      setScanWords(packCheckWords("unreadable").words);
      return;
    }
    const gtins = await db.getAll<{
      gtin: string;
      ampp_id: string;
      start_date: string;
      end_date: string | null;
    }>(DEVICE_GTINS_SQL, [scan.gtin]);
    const products = await db.getAll<{
      id: string;
      kind: string;
      vmp_id: string | null;
      amp_id: string | null;
    }>(DEVICE_PRODUCTS_SQL);
    const check: PackCheck = checkPack(
      scan,
      { vmpId: dose.vmpId, ampId: dose.ampId },
      {
        gtins: gtins.map((g) => ({
          gtin: g.gtin,
          amppId: g.ampp_id,
          startDate: g.start_date,
          endDate: g.end_date,
        })),
        products: products.map((p) => ({
          id: p.id,
          kind: p.kind,
          vmpId: p.vmp_id,
          ampId: p.amp_id,
        })),
      },
      ukToday(new Date()),
    );
    const words = packCheckWords(check);
    setScanWords(words.words);
    // A pack that does not match is never accepted by scanning: the carer stops, or says why.
    setPack(
      words.matches && check.result === "matches"
        ? {
            method: "scanned",
            gtin: scan.gtin,
            batch: scan.batch,
            expiry: scan.expiry,
            amppId: check.amppId,
            override: null,
          }
        : null,
    );
  };

  const packEvidence: PackEvidence | null =
    pack ??
    (overrideCode
      ? {
          method: "override",
          gtin: null,
          batch: null,
          expiry: null,
          amppId: null,
          override: { code: overrideCode, note: overrideNote.trim() || null },
        }
      : null);

  const save = async () => {
    if (!outcome || saving) return;
    const quantity = Number(amount);
    const input = {
      id: newEntryId(),
      tenantId,
      personId: dose.personId,
      entryId: dose.entryId,
      dueAt: dose.dueAt,
      outcome,
      reason: reasonCode ? { code: reasonCode, note: note.trim() || null } : null,
      amount:
        outcome === "given" && amount.trim() && Number.isFinite(quantity) && dose.unitCode
          ? { quantity, unitCode: dose.unitCode }
          : null,
      timingReason: null,
      identity: identity ? ("photo" as const) : null,
      pack: outcome === "given" ? packEvidence : null,
      memberId: me?.tenantUserId ?? "",
      at: new Date(),
      deviceOffsetMs: null,
      mayGive: dose.mayGive,
      controlledDrug: dose.controlledDrug,
    };
    const found = recordProblems(input);
    setProblems(found);
    if (found.length > 0) return;
    setSaving(true);
    try {
      await record(input);
      onDone(true);
    } finally {
      setSaving(false);
    }
  };

  const reasons = outcome ? OUTCOME_REASONS[outcome] : [];
  const gives = outcome === "given";
  return (
    <View style={{ gap: theme.space[1.5] }} testID="dose-record-panel">
      <Text variant="title" accessibilityRole="header">
        {t("mobile.meds.recordTitle", { medicine: dose.productName, person: dose.personName })}
      </Text>
      <Text>{dose.doseInWords}</Text>
      <Text tone="warning" testID="dose-allergies">
        {dose.allergyWords}
      </Text>

      <Text variant="callout" accessibilityRole="header">
        {t("mobile.meds.outcome")}
      </Text>
      <View style={{ gap: theme.space[1] }}>
        {PHONE_OUTCOMES.map((o) => (
          <Button
            key={o}
            label={t("mobile.meds.outcomeName", { outcome: o })}
            variant={outcome === o ? "primary" : "secondary"}
            accessibilityHint={outcome === o ? t("mobile.common.selected") : undefined}
            onPress={() => {
              setOutcome(o);
              setReasonCode(null);
            }}
          />
        ))}
      </View>

      {reasons.length > 0 ? (
        <View style={{ gap: theme.space[1] }}>
          <Text variant="callout" accessibilityRole="header">
            {t("mobile.meds.reason")}
          </Text>
          {reasons.map((code) => (
            <Button
              key={code}
              label={t("mobile.meds.reasonName", { reason: code })}
              variant={reasonCode === code ? "primary" : "secondary"}
              accessibilityHint={reasonCode === code ? t("mobile.common.selected") : undefined}
              onPress={() => setReasonCode(code)}
            />
          ))}
          <TextField
            label={t("mobile.meds.note")}
            hint={t("mobile.meds.noteHint")}
            value={note}
            onChangeText={setNote}
            maxLength={2000}
          />
        </View>
      ) : null}

      {gives ? (
        <View style={{ gap: theme.space[1] }}>
          <Text variant="callout" accessibilityRole="header">
            {t("mobile.meds.checks")}
          </Text>
          <Button
            label={identity ? t("mobile.meds.identityConfirmed") : t("mobile.meds.confirmIdentity")}
            variant={identity ? "primary" : "secondary"}
            accessibilityHint={t("mobile.meds.confirmIdentityHint", { person: dose.personName })}
            onPress={() => setIdentity(true)}
            testID="confirm-identity"
          />
          {scanning ? (
            <PackScanner
              onScanned={(raw) => void scanned(raw)}
              onCancel={() => setScanning(false)}
            />
          ) : (
            <Button
              label={pack ? t("mobile.meds.scanAgain") : t("mobile.meds.scanPack")}
              variant="secondary"
              onPress={() => {
                setScanWords(null);
                setScanning(true);
              }}
              testID="scan-pack"
            />
          )}
          {scanWords ? (
            <Text
              tone={pack ? "success" : "danger"}
              testID="scan-result"
              accessibilityLiveRegion="polite"
            >
              {scanWords}
            </Text>
          ) : null}
          {!pack ? (
            <View style={{ gap: theme.space[1] }}>
              <Text>{t("mobile.meds.overrideTitle")}</Text>
              {PACK_OVERRIDE_REASONS.map((code) => (
                <Button
                  key={code}
                  label={t("mobile.meds.overrideName", { reason: code })}
                  variant={overrideCode === code ? "primary" : "secondary"}
                  accessibilityHint={
                    overrideCode === code ? t("mobile.common.selected") : undefined
                  }
                  onPress={() => setOverrideCode(code)}
                />
              ))}
              {overrideCode === "other" ? (
                <TextField
                  label={t("mobile.meds.overrideNote")}
                  value={overrideNote}
                  onChangeText={setOverrideNote}
                  maxLength={500}
                />
              ) : null}
            </View>
          ) : null}
          <TextField
            label={t("mobile.meds.amount", { unit: dose.unitName ?? "" })}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
        </View>
      ) : null}

      {problems.length > 0 ? (
        <View accessibilityLiveRegion="assertive" testID="dose-problems">
          {problems.map((p) => (
            <Text key={p} tone="danger">
              {t("mobile.meds.problem", { problem: p })}
            </Text>
          ))}
        </View>
      ) : null}
      <Button
        label={t("mobile.meds.save")}
        onPress={() => void save()}
        disabled={!outcome}
        loading={saving}
        testID="save-dose"
      />
      <Button label={t("mobile.round.cancel")} variant="secondary" onPress={() => onDone(false)} />
    </View>
  );
}
