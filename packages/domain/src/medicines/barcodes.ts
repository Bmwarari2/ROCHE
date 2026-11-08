/**
 * Barcodes and positive identification at the point of care (ADR-0081; HZ-001, HZ-113; Phase 2
 * slice 69). A pack's GS1 DataMatrix (GTIN, expiry, batch, serial) or linear GTIN is read and
 * matched to the MAR entry's dm+d product through the pack's AMPP; a different product, a pack the
 * reference data does not know or a pack past its expiry blocks the record unless an override
 * reason is given. Each administration that gives a dose carries how the person was identified:
 * photo confirmation (each person's default, H-512) or their wristband's opaque token. Pure.
 */
import { toGtin14 } from "./dmd-release";

/** What a scanned pack says. Expiry is the last day of use (a GS1 day of 00 is the month's end). */
export interface PackScan {
  readonly gtin: string;
  readonly expiry: string | null;
  readonly batch: string | null;
  readonly serial: string | null;
  readonly symbology: "gs1_datamatrix" | "linear";
}

const GS = "\u001d";
/** AI, and the fixed length of its data, or null for variable (up to 20, ended by GS). */
const AIS: Readonly<Record<string, number | null>> = { "01": 14, "17": 6, "10": null, "21": null };

function expiryOf(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  let day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 0) day = last;
  if (day > last) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The element strings of a GS1 code, from its raw (FNC1 as GS) or bracketed form. */
function gs1Elements(code: string): Map<string, string> | null {
  const out = new Map<string, string>();
  if (code.startsWith("(")) {
    const re = /\((\d{2})\)([^(]*)/g;
    for (const m of code.matchAll(re)) out.set(m[1] as string, m[2] as string);
    return out.size > 0 ? out : null;
  }
  let rest = code.startsWith(GS) ? code.slice(1) : code;
  while (rest.length > 0) {
    const ai = rest.slice(0, 2);
    if (!(ai in AIS)) return null;
    const fixed = AIS[ai];
    if (fixed !== null && fixed !== undefined) {
      const data = rest.slice(2, 2 + fixed);
      if (data.length !== fixed) return null;
      out.set(ai, data);
      rest = rest.slice(2 + fixed);
      if (rest.startsWith(GS)) rest = rest.slice(1);
    } else {
      const end = rest.indexOf(GS);
      const data = end === -1 ? rest.slice(2) : rest.slice(2, end);
      if (data.length === 0 || data.length > 20) return null;
      out.set(ai, data);
      rest = end === -1 ? "" : rest.slice(end + 1);
    }
  }
  return out;
}

/**
 * A pack's barcode as read by the camera, or null when it is not a pack barcode Harbour reads
 * (the person is told so and may scan again or give an override reason).
 */
export function parsePackBarcode(raw: string): PackScan | null {
  let code = raw.trim();
  const symbology = code.startsWith("]d2") || code.startsWith("]Q3") ? "gs1_datamatrix" : null;
  if (/^\][A-Za-z]\d/.test(code)) code = code.slice(3);
  if (/^\d{8}$|^\d{12,14}$/.test(code)) {
    const gtin = toGtin14(code);
    return gtin
      ? { gtin, expiry: null, batch: null, serial: null, symbology: symbology ?? "linear" }
      : null;
  }
  const elements = gs1Elements(code);
  const gtin = elements?.get("01") ? toGtin14(elements.get("01") as string) : null;
  if (!elements || !gtin) return null;
  const rawExpiry = elements.get("17");
  const expiry = rawExpiry === undefined ? null : expiryOf(rawExpiry);
  if (rawExpiry !== undefined && expiry === null) return null;
  return {
    gtin,
    expiry,
    batch: elements.get("10") ?? null,
    serial: elements.get("21") ?? null,
    symbology: "gs1_datamatrix",
  };
}

/** The reference data a pack is matched against: the device subset (ADR-0130). */
export interface PackReference {
  readonly gtins: readonly {
    readonly gtin: string;
    readonly amppId: string;
    readonly startDate: string;
    readonly endDate: string | null;
  }[];
  /** AMPPs and AMPs, each with the AMP and VMP above it. */
  readonly products: readonly {
    readonly kind: string;
    readonly id: string;
    readonly vmpId: string | null;
    readonly ampId: string | null;
  }[];
}

export type PackCheck =
  | { readonly result: "matches"; readonly amppId: string }
  | { readonly result: "different_product"; readonly amppId: string }
  | { readonly result: "unknown_pack" }
  | { readonly result: "expired"; readonly expiry: string };

/**
 * Whether a scanned pack is the MAR entry's product: its AMPP's AMP is the entry's AMP, or, for an
 * entry prescribed generically, its AMP's VMP is the entry's VMP. A GTIN the reference data does
 * not hold for `today` is unknown; a pack whose expiry is before `today` (UK date) is expired.
 */
export function checkPack(
  scan: PackScan,
  product: { readonly vmpId: string; readonly ampId: string | null },
  reference: PackReference,
  today: string,
): PackCheck {
  if (scan.expiry !== null && scan.expiry < today)
    return { result: "expired", expiry: scan.expiry };
  const mapping = reference.gtins.find(
    (g) =>
      g.gtin === scan.gtin && g.startDate <= today && (g.endDate === null || g.endDate >= today),
  );
  if (!mapping) return { result: "unknown_pack" };
  const ampp = reference.products.find((p) => p.kind === "ampp" && p.id === mapping.amppId);
  const ampId = ampp?.ampId ?? null;
  const amp = ampId ? reference.products.find((p) => p.kind === "amp" && p.id === ampId) : null;
  const vmpId = ampp?.vmpId ?? amp?.vmpId ?? null;
  const matches =
    product.ampId !== null ? ampId === product.ampId : vmpId !== null && vmpId === product.vmpId;
  return matches
    ? { result: "matches", amppId: mapping.amppId }
    : { result: "different_product", amppId: mapping.amppId };
}

/** How the person was identified for this administration (H-512). */
export type IdentityCheck = "photo" | "wristband";

/** How the pack was checked: scanned and matched, or recorded with an override reason. */
export type PackCheckRecord = "scanned" | "override";

export const PACK_OVERRIDE_REASONS = [
  "no_barcode_on_pack",
  "barcode_unreadable",
  "pack_not_in_reference_data",
  "patient_own_supply",
  "other",
] as const;
export type PackOverrideReason = (typeof PACK_OVERRIDE_REASONS)[number];

export interface PointOfCareChecks {
  readonly identity: IdentityCheck | null;
  readonly pack: PackCheckRecord | null;
  readonly packOverride: { readonly code: PackOverrideReason; readonly note: string | null } | null;
}

export type PointOfCareIssue =
  | "identity_not_confirmed"
  | "pack_not_checked"
  | "override_note_missing";

export const POINT_OF_CARE_WORDS: Readonly<Record<PointOfCareIssue, string>> = {
  identity_not_confirmed:
    "Confirm who the person is first: check their photo, name and date of birth, or scan their wristband.",
  pack_not_checked: "Scan the pack, or say why it cannot be scanned.",
  override_note_missing: "Say why the pack could not be scanned.",
};

/**
 * hazard HZ-001: a dose given (or about to be given) needs the person positively identified, and
 * the pack scanned or an override reason; an outcome that gives nothing (refused, omitted, not
 * available, withheld) needs neither. The phone checks it before recording.
 */
export function pointOfCareIssues(
  givesADose: boolean,
  checks: PointOfCareChecks,
): PointOfCareIssue[] {
  if (!givesADose) return [];
  const issues: PointOfCareIssue[] = [];
  if (checks.identity === null) issues.push("identity_not_confirmed");
  if (checks.pack === null || (checks.pack === "override" && checks.packOverride === null)) {
    issues.push("pack_not_checked");
  } else if (
    checks.pack === "override" &&
    checks.packOverride?.code === "other" &&
    !checks.packOverride.note?.trim()
  ) {
    issues.push("override_note_missing");
  }
  return issues;
}
