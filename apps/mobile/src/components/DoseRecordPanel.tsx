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
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, findNodeHandle, View } from "react-native";
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
import { CarePersonHeader } from "./CarePersonHeader";
import { PackScanner } from "./PackScanner";
import { StatusLine } from "./StatusLine";
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
  /** A when-required dose's next allowed time (HZ-004). */
  readonly nextAllowedAt: Date | null;
  readonly lastDoseNotOnDevice: boolean;
}

function announce(words: string) {
  // Android reads live regions; iOS needs the announcement (WCAG 4.1.3).
  AccessibilityInfo.announceForAccessibility(words);
}

/**
 * Recording one dose on the round (slice 69; ADR-0081; HZ-001, HZ-004, HZ-113): the person's photo,
 * name and date of birth beside the identity check, the allergy line beside the medicine, the pack
 * scanned and matched (or why it could not be, never after a scan of another medicine or an
 * expired pack), the outcome and its reason. What stops the record is said, and announced, before
 * anything is saved.
 */
export function DoseRecordPanel({
  dose,
  dmdLine,
  onDone,
}: {
  readonly dose: DoseChoice;
  /** When the medicines data a scan is matched against arrived (HZ-113). */
  readonly dmdLine: string;
  readonly onDone: (saved: boolean) => void;
}) {
  const theme = useTheme();
  const db = usePowerSync();
  const tenantId = useTenantId();
  const { me } = useSession();
  const record = useRecordDose();
  const titleRef = useRef<View>(null);
  const [outcome, setOutcome] = useState<AdministrationOutcome | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [identity, setIdentity] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pack, setPack] = useState<PackEvidence | null>(null);
  const [packRefused, setPackRefused] = useState(false);
  const [scanWords, setScanWords] = useState<string | null>(null);
  const [overrideCode, setOverrideCode] = useState<PackOverrideReason | null>(null);
  const [overrideNote, setOverrideNote] = useState("");
  const [amount, setAmount] = useState(dose.quantity === null ? "" : String(dose.quantity));
  const [problems, setProblems] = useState<readonly RecordProblem[]>([]);
  const [saving, setSaving] = useState(false);

  // Focus moves to the panel's title when it opens (WCAG 2.4.3).
  useEffect(() => {
    const node = titleRef.current ? findNodeHandle(titleRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);

  const scanned = async (raw: string) => {
    setScanning(false);
    const scan = parsePackBarcode(raw);
    if (!scan) {
      const words = packCheckWords("unreadable").words;
      setScanWords(words);
      setPack(null);
      announce(words);
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
    announce(words.words);
    // Another medicine or an expired pack stops the dose until a matching pack is scanned: no
    // override reason clears it (clinical review of slice 69, M5).
    setPackRefused(check.result === "different_product" || check.result === "expired");
    setPack(
      check.result === "matches"
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
      nextAllowedAt: dose.nextAllowedAt,
      lastDoseNotOnDevice: dose.lastDoseNotOnDevice,
      packRefused,
    };
    const found = recordProblems(input);
    setProblems(found);
    if (found.length > 0) {
      announce(found.map((p) => t("mobile.meds.problem", { problem: p })).join(" "));
      return;
    }
    setSaving(true);
    try {
      await record(input);
      announce(t("mobile.meds.saved"));
      onDone(true);
    } finally {
      setSaving(false);
    }
  };

  const reasons = outcome ? OUTCOME_REASONS[outcome] : [];
  const gives = outcome === "given";
  return (
    <View style={{ gap: theme.space[1.5] }} testID="dose-record-panel">
      <View ref={titleRef} accessible accessibilityRole="header">
        <Text variant="title">
          {t("mobile.meds.recordTitle", { medicine: dose.productName, person: dose.personName })}
        </Text>
      </View>
      {dose.doseInWords ? <Text>{dose.doseInWords}</Text> : null}
      <StatusLine tone="warning" testID="dose-allergies">
        {dose.allergyWords}
      </StatusLine>

      <Text variant="callout" accessibilityRole="header">
        {t("mobile.meds.outcome")}
      </Text>
      <View accessibilityRole="radiogroup" style={{ gap: theme.space[1] }}>
        {PHONE_OUTCOMES.map((o) => (
          <Button
            key={o}
            label={t("mobile.meds.outcomeName", { outcome: o })}
            selection={{ kind: "radio", selected: outcome === o }}
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
          <View accessibilityRole="radiogroup" style={{ gap: theme.space[1] }}>
            {reasons.map((code) => (
              <Button
                key={code}
                label={t("mobile.meds.reasonName", { reason: code })}
                selection={{ kind: "radio", selected: reasonCode === code }}
                onPress={() => setReasonCode(code)}
              />
            ))}
          </View>
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
          {/* The photo, name and date of birth beside the check they are for (HZ-001). */}
          <CarePersonHeader personId={dose.personId} />
          <Button
            label={t("mobile.meds.confirmIdentity")}
            selection={{ kind: "checkbox", selected: identity }}
            accessibilityHint={t("mobile.meds.confirmIdentityHint", { person: dose.personName })}
            onPress={() => setIdentity((v) => !v)}
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
          <Text variant="bodyDense" tone="secondary" testID="dmd-subset-line">
            {dmdLine}
          </Text>
          {scanWords ? (
            <StatusLine tone={pack ? "success" : "danger"} testID="scan-result">
              {scanWords}
            </StatusLine>
          ) : null}
          {!pack && !packRefused ? (
            <View style={{ gap: theme.space[1] }}>
              <Text>{t("mobile.meds.overrideTitle")}</Text>
              <View accessibilityRole="radiogroup" style={{ gap: theme.space[1] }}>
                {PACK_OVERRIDE_REASONS.map((code) => (
                  <Button
                    key={code}
                    label={t("mobile.meds.overrideName", { reason: code })}
                    selection={{ kind: "radio", selected: overrideCode === code }}
                    onPress={() => setOverrideCode(code)}
                  />
                ))}
              </View>
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
            label={t("mobile.meds.amount", { unit: dose.unitName ?? "none" })}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
        </View>
      ) : null}

      {problems.length > 0 ? (
        <View testID="dose-problems" style={{ gap: theme.space[0.5] }}>
          {problems.map((p) => (
            <StatusLine key={p} tone="danger">
              {t("mobile.meds.problem", { problem: p })}
            </StatusLine>
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
      <Button
        label={t("mobile.meds.stop")}
        accessibilityHint={t("mobile.meds.stopHint")}
        variant="secondary"
        onPress={() => onDone(false)}
      />
    </View>
  );
}
