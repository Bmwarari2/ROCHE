/**
 * The medicines round's data on the phone (slice 69): the synced rows, the gate and each person's
 * round, again each minute; and the hook that records a dose to the phone's own copy, from where
 * the connector sends it (`medicines-upload.ts`).
 */
import type { MedicinesRates } from "@harbour/domain";
import { usePowerSync, useQuery, useStatus } from "@powersync/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useVault } from "../app-state/vault";
import { useTenantId } from "../care/hooks";
import { appEnv } from "../config/app-env";
import { PEOPLE_LIST_SQL, type PersonRow, peopleListParams } from "../people/queries";
import { scheduleMedicineReminders } from "../platform/notifications";
import {
  MEDICINES_RATES_SQL,
  medicinesRatesParams,
  ROUND_ADMINISTRATIONS_SQL,
  ROUND_MEDICATION_SQL,
  ROUND_SCHEDULE_SQL,
} from "./queries";
import { parseMedicinesRates } from "./rates";
import { type DoseRecordInput, localAdministrationRow } from "./record";
import { planTimeCriticalReminders } from "./reminders";
import {
  type AdministrationLocalRow,
  type MedicationLocalRow,
  type PersonRound,
  phoneRound,
  type RoundGate,
  roundGate,
  type ScheduleLocalRow,
} from "./round";

/** The person as the people list reads them: name, allergies and communication needs. */
export type RoundPersonRow = PersonRow;

/** The time, again each minute, so a dose becomes due or late on the screen as it does. */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The slot shown: from the start of this hour to six hours on. Late doses since yesterday join. */
export function roundSlot(now: Date): { readonly from: Date; readonly to: Date } {
  const from = new Date(now);
  from.setMinutes(0, 0, 0);
  return { from, to: new Date(from.getTime() + 6 * 3_600_000) };
}

export function useMedicinesRound(): {
  readonly gate: RoundGate;
  readonly rounds: readonly PersonRound[];
  readonly people: ReadonlyMap<string, RoundPersonRow>;
  readonly rates: MedicinesRates | null;
  /** The administrations on this phone, for corrections (slice 70). */
  readonly administrations: readonly AdministrationLocalRow[];
  readonly loading: boolean;
  readonly now: Date;
} {
  const tenantId = useTenantId();
  const status = useStatus();
  const { integrity } = useVault();
  const now = useMinute();
  const params = useMemo(() => [tenantId], [tenantId]);
  const meds = useQuery<MedicationLocalRow>(ROUND_MEDICATION_SQL, params);
  const times = useQuery<ScheduleLocalRow>(ROUND_SCHEDULE_SQL, params);
  const given = useQuery<AdministrationLocalRow>(ROUND_ADMINISTRATIONS_SQL, params);
  const peopleParams = useMemo(() => peopleListParams(tenantId), [tenantId]);
  const persons = useQuery<RoundPersonRow>(PEOPLE_LIST_SQL, peopleParams);
  const rateRows = useQuery<{ value: string }>(MEDICINES_RATES_SQL, medicinesRatesParams);
  const rates = useMemo(() => parseMedicinesRates(rateRows.data[0]?.value), [rateRows.data]);
  const gate = roundGate({
    integrity: integrity?.status ?? null,
    hasSynced: appEnv.demoMode || status.hasSynced === true,
    rates,
    demo: appEnv.demoMode,
  });
  const rounds = useMemo(
    () =>
      gate.kind === "ready" && rates
        ? phoneRound({
            medications: meds.data,
            schedules: times.data,
            administrations: given.data,
            rates,
            ...roundSlot(now),
            now,
          })
        : [],
    [gate.kind, rates, meds.data, times.data, given.data, now],
  );
  // Reminders for the time-critical doses on this phone, replaced whenever the round changes.
  useEffect(() => {
    if (gate.kind === "ready")
      void scheduleMedicineReminders(planTimeCriticalReminders(rounds, now));
  }, [gate.kind, rounds, now]);
  const people = useMemo(() => new Map(persons.data.map((p) => [p.id, p])), [persons.data]);
  return {
    gate,
    rounds,
    people,
    rates,
    administrations: given.data,
    loading: !tenantId || meds.isLoading || given.isLoading,
    now,
  };
}

/** Writes a dose to the phone's copy; the connector sends it. */
export function useRecordDose(): (input: DoseRecordInput) => Promise<void> {
  const db = usePowerSync();
  return useCallback(
    async (input) => {
      const row = localAdministrationRow(input);
      const columns = Object.keys(row);
      await db.execute(
        `INSERT INTO medication_administration (${columns.join(", ")}) VALUES (${columns
          .map(() => "?")
          .join(", ")})`,
        columns.map((c) => row[c] ?? null),
      );
    },
    [db],
  );
}
