/**
 * The dm+d rows the phone's MARs need (integrations.md section 12 rule 9; ADR-0130; slice 68),
 * from `GET /v1/medicines/device-subset`, kept in `dmd_device_product` and `dmd_device_gtin`
 * (local-only) and replaced whole at each fetch, so a pack or barcode that left the subset never
 * matches a scan offline (HZ-113). National reference data: no personal data. Pure apart from the
 * statements' order, so it is tested against the phone's own schema.
 */

export interface DeviceProduct {
  readonly kind: "vmp" | "amp" | "vmpp" | "ampp";
  readonly id: string;
  readonly name: string;
  readonly vmpId: string | null;
  readonly ampId: string | null;
  readonly vmppId: string | null;
  readonly invalid: boolean;
  readonly supersededBy: string | null;
}

export interface DeviceGtin {
  readonly gtin: string;
  readonly amppId: string;
  readonly startDate: string;
  readonly endDate: string | null;
}

export interface DeviceSubset {
  readonly products: readonly DeviceProduct[];
  readonly gtins: readonly DeviceGtin[];
  readonly unresolved: readonly string[];
}

/** When the subset was last fetched, in `sync_meta`. */
export const DMD_SUBSET_META_ID = "meta:dmd-subset-at";

/** How often the phone asks again while connected (a product setting): every hour. */
export const DMD_SUBSET_REFRESH_MS = 60 * 60 * 1000;

const DMD_ID = /^[1-9]\d{5,17}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(["vmp", "amp", "vmpp", "ampp"]);

const idOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" && DMD_ID.test(v) ? v : undefined;

/** Reads the API's answer, or null when anything in it is not as the contract says. */
export function parseDeviceSubset(body: unknown): DeviceSubset | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.products) || !Array.isArray(b.gtins) || !Array.isArray(b.unresolved)) {
    return null;
  }
  const products: DeviceProduct[] = [];
  for (const p of b.products) {
    if (typeof p !== "object" || p === null) return null;
    const r = p as Record<string, unknown>;
    const vmpId = idOrNull(r.vmpId);
    const ampId = idOrNull(r.ampId);
    const vmppId = idOrNull(r.vmppId);
    const supersededBy = idOrNull(r.supersededBy);
    if (
      typeof r.kind !== "string" ||
      !KINDS.has(r.kind) ||
      typeof r.id !== "string" ||
      !DMD_ID.test(r.id) ||
      typeof r.name !== "string" ||
      typeof r.invalid !== "boolean" ||
      vmpId === undefined ||
      ampId === undefined ||
      vmppId === undefined ||
      supersededBy === undefined
    ) {
      return null;
    }
    products.push({
      kind: r.kind as DeviceProduct["kind"],
      id: r.id,
      name: r.name,
      vmpId,
      ampId,
      vmppId,
      invalid: r.invalid,
      supersededBy,
    });
  }
  const gtins: DeviceGtin[] = [];
  for (const g of b.gtins) {
    if (typeof g !== "object" || g === null) return null;
    const r = g as Record<string, unknown>;
    if (
      typeof r.gtin !== "string" ||
      !/^\d{8,14}$/.test(r.gtin) ||
      typeof r.amppId !== "string" ||
      !DMD_ID.test(r.amppId) ||
      typeof r.startDate !== "string" ||
      !DATE.test(r.startDate) ||
      !(r.endDate === null || (typeof r.endDate === "string" && DATE.test(r.endDate)))
    ) {
      return null;
    }
    gtins.push({ gtin: r.gtin, amppId: r.amppId, startDate: r.startDate, endDate: r.endDate });
  }
  if (!b.unresolved.every((u) => typeof u === "string")) return null;
  return { products, gtins, unresolved: b.unresolved as string[] };
}

export interface SqlStatement {
  readonly sql: string;
  readonly params: (string | number | null)[];
}

/**
 * The statements that replace the phone's subset with this one, in one transaction: everything
 * old removed first, so nothing that left the subset stays.
 */
export function replaceSubsetStatements(subset: DeviceSubset, at: Date): SqlStatement[] {
  const out: SqlStatement[] = [
    { sql: "DELETE FROM dmd_device_product", params: [] },
    { sql: "DELETE FROM dmd_device_gtin", params: [] },
  ];
  for (const p of subset.products) {
    out.push({
      sql: `INSERT INTO dmd_device_product (id, kind, name, vmp_id, amp_id, vmpp_id, invalid,
        detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        `${p.kind}:${p.id}`,
        p.kind,
        p.name,
        p.vmpId,
        p.ampId,
        p.vmppId,
        p.invalid ? 1 : 0,
        JSON.stringify({ id: p.id, supersededBy: p.supersededBy }),
      ],
    });
  }
  for (const u of subset.unresolved) {
    out.push({
      sql: `INSERT INTO dmd_device_product (id, kind, name, vmp_id, amp_id, vmpp_id, invalid,
        detail) VALUES (?, 'unresolved', ?, NULL, NULL, NULL, 1, NULL)`,
      params: [`unresolved:${u}`, u],
    });
  }
  for (const g of subset.gtins) {
    out.push({
      sql: `INSERT INTO dmd_device_gtin (id, gtin, ampp_id, start_date, end_date)
        VALUES (?, ?, ?, ?, ?)`,
      params: [`${g.amppId}:${g.gtin}:${g.startDate}`, g.gtin, g.amppId, g.startDate, g.endDate],
    });
  }
  out.push({
    sql: "INSERT OR REPLACE INTO sync_meta (id, key, value) VALUES (?, ?, ?)",
    params: [DMD_SUBSET_META_ID, DMD_SUBSET_META_ID, at.toISOString()],
  });
  return out;
}

/** Whether the subset is due to be asked for again. */
export function subsetDue(lastAt: string | null | undefined, now: Date): boolean {
  const last = lastAt ? Date.parse(lastAt) : Number.NaN;
  return (
    !Number.isFinite(last) || now.getTime() - last >= DMD_SUBSET_REFRESH_MS || last > now.getTime()
  );
}
