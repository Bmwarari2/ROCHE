/**
 * The medicines figures the round reads (dose windows, the paracetamol interval and the rest of
 * `MEDICINES_RATE_KEYS`), from the rate table through `GET /v1/rates/{key}`, never literals. The
 * phone reads them whenever the vault opens online and keeps them in `sync_meta` for offline
 * rounds. Until every figure has been read once the round is not offered (HZ-003): a window the
 * phone guessed could call a dose late or early when it is not.
 */
import { MEDICINES_RATE_KEYS, type MedicinesRates } from "@harbour/domain";
import { type FetchWindowOptions, fetchRate, type MetaStore } from "../sync/offline-window";

export const MEDICINES_RATES_META_ID = "meta:medicines-rates";
const META_KEY = "medicines_rates";

/** Every figure as a finite number, or null when any is missing or unusable. */
export function parseMedicinesRates(value: unknown): MedicinesRates | null {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const out: Record<string, number> = {};
  for (const name of Object.keys(MEDICINES_RATE_KEYS)) {
    const v = (raw as Record<string, unknown>)[name];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    out[name] = v;
  }
  return out as MedicinesRates;
}

/** Reads every figure; null if any cannot be read, so a partial set is never kept. */
export async function fetchMedicinesRates(
  options: FetchWindowOptions,
): Promise<MedicinesRates | null> {
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(MEDICINES_RATE_KEYS)) {
    const rate = await fetchRate(options, key);
    out[name] = typeof rate?.value === "string" ? Number(rate.value) : rate?.value;
  }
  return parseMedicinesRates(out);
}

export async function writeCachedMedicinesRates(db: MetaStore, rates: MedicinesRates) {
  await db.execute("DELETE FROM sync_meta WHERE id = ?", [MEDICINES_RATES_META_ID]);
  await db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    MEDICINES_RATES_META_ID,
    META_KEY,
    JSON.stringify(rates),
  ]);
}

/** Online: read and cache the figures. Never throws; the cached set stays on a failure. */
export async function refreshMedicinesRates(
  db: MetaStore,
  options: FetchWindowOptions,
): Promise<void> {
  try {
    const rates = await fetchMedicinesRates(options);
    if (rates) await writeCachedMedicinesRates(db, rates);
  } catch {
    // The round keeps the figures it has, or waits for them.
  }
}
