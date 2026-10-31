import { createHash } from "node:crypto";
import {
  DMD_PROBLEMS_KEPT,
  DMD_RELEASE_FILES,
  type DmdAmp,
  type DmdAmpp,
  type DmdGtin,
  type DmdLookupEntry,
  type DmdLookupKind,
  type DmdReleaseContent,
  type DmdReleaseFile,
  type DmdReleaseFiles,
  type DmdReleaseProblem,
  type DmdVmp,
  type DmdVmpp,
  type DmdVtm,
  toGtin14,
} from "@harbour/domain";
import { SaxesParser } from "saxes";

/**
 * Reads an NHSBSA dm+d release (data model R2 XML: `f_lookup2`, `f_vtm2`, `f_vmp2`, `f_amp2`,
 * `f_vmpp2`, `f_ampp2` and the supplementary `f_gtin2`) into the domain's release content
 * (integrations.md section 11; ADR-0080). Only what Harbour keeps is read: names, identifiers,
 * invalid flags, previous identifiers, the form, routes, units and controlled drug category, packs,
 * legal category, discontinuation and GTINs. Ingredients are read only for the units their strengths
 * are given in, never kept (medical-device boundary). A document type declaration is refused, so
 * no entity can be declared or expanded.
 */

const FILE_NAME = /^f_(lookup|vtm|vmp|amp|vmpp|ampp|gtin)2_\d+\.xml$/;

const ROOTS: Record<DmdReleaseFile, string> = {
  lookup: "LOOKUP",
  vtm: "VIRTUAL_THERAPEUTIC_MOIETIES",
  vmp: "VIRTUAL_MED_PRODUCTS",
  amp: "ACTUAL_MEDICINAL_PRODUCTS",
  vmpp: "VIRTUAL_MED_PRODUCT_PACK",
  ampp: "ACTUAL_MEDICINAL_PROD_PACKS",
  gtin: "GTIN_DETAILS",
};

/** The `f_lookup2` sections Harbour keeps. */
const LOOKUP_SECTIONS: Record<string, DmdLookupKind> = {
  UNIT_OF_MEASURE: "unit_of_measure",
  FORM: "form",
  ROUTE: "route",
  CONTROL_DRUG_CATEGORY: "control_drug_category",
  LEGAL_CATEGORY: "legal_category",
};

interface RawRecord {
  readonly fields: Map<string, string>;
  readonly groups: RawRecord[];
}

interface RecordSpec {
  /** Element names below the root down to the record element. */
  readonly path: readonly string[];
  /** A repeated child element whose own fields form a group (GTINDATA). */
  readonly group?: string;
}

class DmdXmlError extends Error {}

/** Reads the records of one file. Fields are the text of a record's leaf elements. */
function readRecords<K extends string>(
  xml: string,
  root: string,
  specs: Record<K, RecordSpec>,
): Record<K, RawRecord[]> {
  const keys = Object.keys(specs) as K[];
  const out = Object.fromEntries(keys.map((k) => [k, [] as RawRecord[]])) as Record<K, RawRecord[]>;
  const parser = new SaxesParser({ position: true });
  const stack: string[] = [];
  let current: { key: K; depth: number; record: RawRecord } | null = null;
  let group: { depth: number; record: RawRecord } | null = null;
  let text = "";
  let sawRoot = false;
  const setField = (record: RawRecord, name: string, value: string) => {
    if (!record.fields.has(name)) record.fields.set(name, value.trim());
  };

  parser.on("doctype", () => {
    throw new DmdXmlError("A document type declaration is not allowed.");
  });
  parser.on("opentag", (tag) => {
    if (stack.length === 0) {
      if (tag.name !== root) throw new DmdXmlError(`Expected <${root}>, found <${tag.name}>.`);
      sawRoot = true;
    }
    stack.push(tag.name);
    text = "";
    const depth = stack.length - 1;
    if (current === null) {
      for (const key of keys) {
        const { path } = specs[key];
        if (path.length === depth && path.every((p, i) => stack[i + 1] === p)) {
          current = { key, depth, record: { fields: new Map(), groups: [] } };
          break;
        }
      }
    } else if (
      group === null &&
      depth === current.depth + 1 &&
      specs[current.key].group === tag.name
    ) {
      group = { depth, record: { fields: new Map(), groups: [] } };
    }
  });
  parser.on("text", (t) => {
    text += t;
  });
  parser.on("cdata", (t) => {
    text += t;
  });
  parser.on("closetag", (tag) => {
    const depth = stack.length - 1;
    if (current !== null) {
      if (group !== null) {
        if (depth === group.depth + 1) setField(group.record, tag.name, text);
        else if (depth === group.depth) {
          current.record.groups.push(group.record);
          group = null;
        }
      } else if (depth === current.depth + 1) setField(current.record, tag.name, text);
      else if (depth === current.depth) {
        out[current.key].push(current.record);
        current = null;
      }
    }
    stack.pop();
    text = "";
  });
  parser.write(xml).close();
  if (!sawRoot) throw new DmdXmlError(`No <${root}> element.`);
  return out;
}

const value = (r: RawRecord, name: string): string | null => {
  const v = r.fields.get(name);
  return v === undefined || v === "" ? null : v;
};
const required = (r: RawRecord, name: string): string => value(r, name) ?? "";
const flag = (r: RawRecord, name: string): boolean => value(r, name) === "1";
/** A field of the first of some records (a VMP has one form and one controlled drug category). */
const first = (rows: readonly RawRecord[] | undefined, name: string): string | null =>
  rows?.[0] === undefined ? null : value(rows[0], name);

function groupBy(rows: readonly RawRecord[], field: string): Map<string, RawRecord[]> {
  const out = new Map<string, RawRecord[]>();
  for (const row of rows) {
    const key = required(row, field);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

const unique = (values: readonly (string | null)[]): string[] => [
  ...new Set(values.filter((v): v is string => v !== null)),
];

function readLookups(xml: string): DmdLookupEntry[] {
  const specs = Object.fromEntries(
    Object.keys(LOOKUP_SECTIONS).map((s) => [s, { path: [s, "INFO"] }]),
  ) as Record<string, RecordSpec>;
  const records = readRecords(xml, ROOTS.lookup, specs);
  return Object.entries(LOOKUP_SECTIONS).flatMap(([section, kind]) =>
    (records[section] ?? []).map((r) => ({
      kind,
      code: required(r, "CD"),
      description: required(r, "DESC"),
      previousCode: value(r, "CDPREV"),
    })),
  );
}

function readVtms(xml: string): DmdVtm[] {
  return readRecords(xml, ROOTS.vtm, { vtm: { path: ["VTM"] } }).vtm.map((r) => ({
    id: required(r, "VTMID"),
    name: required(r, "NM"),
    abbreviatedName: value(r, "ABBREVNM"),
    invalid: flag(r, "INVALID"),
    previousId: value(r, "VTMIDPREV"),
  }));
}

function readVmps(xml: string, problems: DmdReleaseProblem[]): DmdVmp[] {
  const r = readRecords(xml, ROOTS.vmp, {
    vmp: { path: ["VMPS", "VMP"] },
    vpi: { path: ["VIRTUAL_PRODUCT_INGREDIENT", "VPI"] },
    form: { path: ["DRUG_FORM", "DFORM"] },
    route: { path: ["DRUG_ROUTE", "DROUTE"] },
    control: { path: ["CONTROL_DRUG_INFO", "CONTROL_INFO"] },
  });
  const vpis = groupBy(r.vpi, "VPID");
  const forms = groupBy(r.form, "VPID");
  const routes = groupBy(r.route, "VPID");
  const controls = groupBy(r.control, "VPID");
  const ids = new Set(r.vmp.map((v) => required(v, "VPID")));
  for (const [section, rows] of [
    ["VIRTUAL_PRODUCT_INGREDIENT", vpis],
    ["DRUG_FORM", forms],
    ["DRUG_ROUTE", routes],
    ["CONTROL_DRUG_INFO", controls],
  ] as const) {
    for (const id of rows.keys()) {
      if (!ids.has(id)) {
        problems.push({
          code: "missing_reference",
          file: "vmp",
          id,
          message: `${section} names VMP ${id}, not in the release.`,
        });
      }
    }
  }
  return r.vmp.map((v) => {
    const id = required(v, "VPID");
    return {
      id,
      vtmId: value(v, "VTMID"),
      name: required(v, "NM"),
      abbreviatedName: value(v, "ABBREVNM"),
      invalid: flag(v, "INVALID"),
      previousId: value(v, "VPIDPREV"),
      unitDoseUomCode: value(v, "UNIT_DOSE_UOMCD"),
      udfs: value(v, "UDFS"),
      udfsUomCode: value(v, "UDFS_UOMCD"),
      strengthUomCodes: unique((vpis.get(id) ?? []).map((i) => value(i, "STRNT_NMRTR_UOMCD"))),
      formCode: first(forms.get(id), "FORMCD"),
      routeCodes: unique((routes.get(id) ?? []).map((i) => value(i, "ROUTECD"))),
      controlDrugCategoryCode: first(controls.get(id), "CATCD"),
    };
  });
}

function readAmps(xml: string, problems: DmdReleaseProblem[]): DmdAmp[] {
  const r = readRecords(xml, ROOTS.amp, {
    amp: { path: ["AMPS", "AMP"] },
    route: { path: ["LICENSED_ROUTE", "LIC_ROUTE"] },
  });
  const routes = groupBy(r.route, "APID");
  const ids = new Set(r.amp.map((a) => required(a, "APID")));
  for (const id of routes.keys()) {
    if (!ids.has(id)) {
      problems.push({
        code: "missing_reference",
        file: "amp",
        id,
        message: `LICENSED_ROUTE names AMP ${id}, not in the release.`,
      });
    }
  }
  return r.amp.map((a) => {
    const id = required(a, "APID");
    return {
      id,
      vmpId: required(a, "VPID"),
      name: required(a, "NM"),
      abbreviatedName: value(a, "ABBREVNM"),
      description: value(a, "DESC") ?? required(a, "NM"),
      invalid: flag(a, "INVALID"),
      licensedRouteCodes: unique((routes.get(id) ?? []).map((i) => value(i, "ROUTECD"))),
    };
  });
}

function readVmpps(xml: string): DmdVmpp[] {
  return readRecords(xml, ROOTS.vmpp, { vmpp: { path: ["VMPPS", "VMPP"] } }).vmpp.map((r) => ({
    id: required(r, "VPPID"),
    vmpId: required(r, "VPID"),
    name: required(r, "NM"),
    quantity: value(r, "QTYVAL"),
    quantityUomCode: value(r, "QTY_UOMCD"),
    invalid: flag(r, "INVALID"),
  }));
}

function readAmpps(xml: string): DmdAmpp[] {
  return readRecords(xml, ROOTS.ampp, { ampp: { path: ["AMPPS", "AMPP"] } }).ampp.map((r) => ({
    id: required(r, "APPID"),
    vmppId: required(r, "VPPID"),
    ampId: required(r, "APID"),
    name: required(r, "NM"),
    abbreviatedName: value(r, "ABBREVNM"),
    legalCategoryCode: value(r, "LEGAL_CATCD"),
    discontinued: value(r, "DISCCD") !== null,
    discontinuedOn: value(r, "DISCDT"),
    invalid: flag(r, "INVALID"),
  }));
}

function readGtins(xml: string): DmdGtin[] {
  const records = readRecords(xml, ROOTS.gtin, {
    ampp: { path: ["AMPPS", "AMPP"], group: "GTINDATA" },
  });
  return records.ampp.flatMap((r) =>
    r.groups.map((g) => {
      const raw = required(g, "GTIN");
      return {
        amppId: required(r, "AMPPID"),
        // An invalid GTIN is kept as written, so the check names it.
        gtin: toGtin14(raw) ?? raw,
        startDate: required(g, "STARTDT"),
        endDate: value(g, "ENDDT"),
      };
    }),
  );
}

export interface ParsedDmdRelease {
  /** Null when a file is missing or unreadable. */
  readonly content: DmdReleaseContent | null;
  readonly problems: readonly DmdReleaseProblem[];
  readonly problemCount: number;
  /** Records read per file, and the files ignored (not ones Harbour reads). */
  readonly fileCounts: Readonly<Record<string, number>>;
  /** SHA-256 over every file's name and content, in name order. */
  readonly checksum: string;
}

/** SHA-256 over the files, in name order: the same files always give the same checksum. */
export function dmdReleaseChecksum(files: DmdReleaseFiles["files"]): string {
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(f.name).update("\0").update(f.content).update("\0");
  }
  return hash.digest("hex");
}

/**
 * Reads a release's files. Problems here (a file missing, repeated or unreadable, a section naming
 * a product the file does not hold) refuse the release before `checkDmdRelease` runs.
 */
export function parseDmdRelease(release: DmdReleaseFiles): ParsedDmdRelease {
  const problems: DmdReleaseProblem[] = [];
  const byKind = new Map<DmdReleaseFile, string>();
  let ignored = 0;
  for (const file of release.files) {
    const match = FILE_NAME.exec(file.name);
    if (!match) {
      ignored += 1;
      continue;
    }
    const kind = match[1] as DmdReleaseFile;
    if (byKind.has(kind)) {
      problems.push({
        code: "file_repeated",
        file: kind,
        id: null,
        message: `The release has more than one ${kind} file.`,
      });
    }
    byKind.set(kind, file.content);
  }
  for (const kind of DMD_RELEASE_FILES) {
    if (!byKind.has(kind)) {
      problems.push({
        code: "file_missing",
        file: kind,
        id: null,
        message: `The release has no ${kind} file.`,
      });
    }
  }

  const read = <T>(kind: DmdReleaseFile, fn: (xml: string) => T[]): T[] => {
    const xml = byKind.get(kind);
    if (xml === undefined) return [];
    try {
      return fn(xml);
    } catch (error) {
      problems.push({
        code: "unreadable_xml",
        file: kind,
        id: null,
        message: `The ${kind} file is not readable dm+d XML: ${(error as Error).message}`.slice(
          0,
          300,
        ),
      });
      return [];
    }
  };
  const lookups = read("lookup", readLookups);
  const vtms = read("vtm", readVtms);
  const vmps = read("vmp", (xml) => readVmps(xml, problems));
  const amps = read("amp", (xml) => readAmps(xml, problems));
  const vmpps = read("vmpp", readVmpps);
  const ampps = read("ampp", readAmpps);
  const gtins = read("gtin", readGtins);

  const fileCounts = {
    lookup: lookups.length,
    vtm: vtms.length,
    vmp: vmps.length,
    amp: amps.length,
    vmpp: vmpps.length,
    ampp: ampps.length,
    gtin: gtins.length,
    ignored,
  };
  const checksum = dmdReleaseChecksum(release.files);
  const blocked = problems.some(
    (p) => p.code === "file_missing" || p.code === "unreadable_xml" || p.code === "file_repeated",
  );
  return {
    content: blocked
      ? null
      : {
          name: release.name,
          releasedOn: release.releasedOn,
          lookups,
          vtms,
          vmps,
          amps,
          vmpps,
          ampps,
          gtins,
        },
    problems: problems.slice(0, DMD_PROBLEMS_KEPT),
    problemCount: problems.length,
    fileCounts,
    checksum,
  };
}
