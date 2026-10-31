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

/**
 * Reads the records of one file as its chunks arrive. Fields are the text of a record's leaf
 * elements; text outside a record is never kept.
 */
class RecordReader<K extends string> {
  private readonly parser = new SaxesParser({ position: true });
  private readonly keys: K[];
  private readonly out: Record<K, RawRecord[]>;
  private readonly stack: string[] = [];
  private current: { key: K; depth: number; record: RawRecord } | null = null;
  private group: { depth: number; record: RawRecord } | null = null;
  private text = "";
  private sawRoot = false;

  constructor(
    private readonly root: string,
    private readonly specs: Record<K, RecordSpec>,
  ) {
    this.keys = Object.keys(specs) as K[];
    this.out = Object.fromEntries(this.keys.map((k) => [k, [] as RawRecord[]])) as Record<
      K,
      RawRecord[]
    >;
    this.parser.on("doctype", () => {
      throw new DmdXmlError("A document type declaration is not allowed.");
    });
    this.parser.on("opentag", (tag) => this.open(tag.name));
    this.parser.on("text", (t) => {
      if (this.current !== null) this.text += t;
    });
    this.parser.on("cdata", (t) => {
      if (this.current !== null) this.text += t;
    });
    this.parser.on("closetag", (tag) => this.close(tag.name));
  }

  private open(name: string): void {
    if (this.stack.length === 0) {
      if (name !== this.root) throw new DmdXmlError(`Expected <${this.root}>, found <${name}>.`);
      this.sawRoot = true;
    }
    this.stack.push(name);
    this.text = "";
    const depth = this.stack.length - 1;
    if (this.current === null) {
      for (const key of this.keys) {
        const { path } = this.specs[key];
        if (path.length === depth && path.every((p, i) => this.stack[i + 1] === p)) {
          this.current = { key, depth, record: { fields: new Map(), groups: [] } };
          break;
        }
      }
    } else if (
      this.group === null &&
      depth === this.current.depth + 1 &&
      this.specs[this.current.key].group === name
    ) {
      this.group = { depth, record: { fields: new Map(), groups: [] } };
    }
  }

  private close(name: string): void {
    const depth = this.stack.length - 1;
    const setField = (record: RawRecord) => {
      if (!record.fields.has(name)) record.fields.set(name, this.text.trim());
    };
    const current = this.current;
    if (current !== null) {
      if (this.group !== null) {
        if (depth === this.group.depth + 1) setField(this.group.record);
        else if (depth === this.group.depth) {
          current.record.groups.push(this.group.record);
          this.group = null;
        }
      } else if (depth === current.depth + 1) setField(current.record);
      else if (depth === current.depth) {
        this.out[current.key].push(current.record);
        this.current = null;
      }
    }
    this.stack.pop();
    this.text = "";
  }

  write(chunk: string): void {
    this.parser.write(chunk);
  }

  end(): Record<K, RawRecord[]> {
    this.parser.close();
    if (!this.sawRoot) throw new DmdXmlError(`No <${this.root}> element.`);
    return this.out;
  }
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

/** The records each file is read for. */
const SPECS: Record<DmdReleaseFile, Record<string, RecordSpec>> = {
  lookup: Object.fromEntries(Object.keys(LOOKUP_SECTIONS).map((s) => [s, { path: [s, "INFO"] }])),
  vtm: { vtm: { path: ["VTM"] } },
  vmp: {
    vmp: { path: ["VMPS", "VMP"] },
    vpi: { path: ["VIRTUAL_PRODUCT_INGREDIENT", "VPI"] },
    form: { path: ["DRUG_FORM", "DFORM"] },
    route: { path: ["DRUG_ROUTE", "DROUTE"] },
    control: { path: ["CONTROL_DRUG_INFO", "CONTROL_INFO"] },
  },
  amp: { amp: { path: ["AMPS", "AMP"] }, route: { path: ["LICENSED_ROUTE", "LIC_ROUTE"] } },
  vmpp: { vmpp: { path: ["VMPPS", "VMPP"] } },
  ampp: { ampp: { path: ["AMPPS", "AMPP"] } },
  gtin: { ampp: { path: ["AMPPS", "AMPP"], group: "GTINDATA" } },
};

type Records = Record<string, RawRecord[]>;
const of = (records: Records, key: string): RawRecord[] => records[key] ?? [];

function readLookups(records: Records): DmdLookupEntry[] {
  return Object.entries(LOOKUP_SECTIONS).flatMap(([section, kind]) =>
    (records[section] ?? []).map((r) => ({
      kind,
      code: required(r, "CD"),
      description: required(r, "DESC"),
      previousCode: value(r, "CDPREV"),
    })),
  );
}

function readVtms(records: Records): DmdVtm[] {
  return of(records, "vtm").map((r) => ({
    id: required(r, "VTMID"),
    name: required(r, "NM"),
    abbreviatedName: value(r, "ABBREVNM"),
    invalid: flag(r, "INVALID"),
    previousId: value(r, "VTMIDPREV"),
  }));
}

function readVmps(records: Records, problems: DmdReleaseProblem[]): DmdVmp[] {
  const vmps = of(records, "vmp");
  const vpis = groupBy(of(records, "vpi"), "VPID");
  const forms = groupBy(of(records, "form"), "VPID");
  const routes = groupBy(of(records, "route"), "VPID");
  const controls = groupBy(of(records, "control"), "VPID");
  const ids = new Set(vmps.map((v) => required(v, "VPID")));
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
  return vmps.map((v) => {
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

function readAmps(records: Records, problems: DmdReleaseProblem[]): DmdAmp[] {
  const amps = of(records, "amp");
  const routes = groupBy(of(records, "route"), "APID");
  const ids = new Set(amps.map((a) => required(a, "APID")));
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
  return amps.map((a) => {
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

function readVmpps(records: Records): DmdVmpp[] {
  return of(records, "vmpp").map((r) => ({
    id: required(r, "VPPID"),
    vmpId: required(r, "VPID"),
    name: required(r, "NM"),
    quantity: value(r, "QTYVAL"),
    quantityUomCode: value(r, "QTY_UOMCD"),
    invalid: flag(r, "INVALID"),
  }));
}

function readAmpps(records: Records): DmdAmpp[] {
  return of(records, "ampp").map((r) => ({
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

function readGtins(records: Records): DmdGtin[] {
  return of(records, "ampp").flatMap((r) =>
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
  /** Null when a file is missing, repeated or unreadable, or the release is too large. */
  readonly content: DmdReleaseContent | null;
  readonly problems: readonly DmdReleaseProblem[];
  readonly problemCount: number;
  /** Records read per file, and the files ignored (not ones Harbour reads). */
  readonly fileCounts: Readonly<Record<string, number>>;
  /** SHA-256 over every file's name and content, in name order; null when not read. */
  readonly checksum: string | null;
}

/** The load ran past its time limit (`DmdLoadLimits.timeoutMs`). */
export class DmdLoadTimeout extends Error {
  constructor() {
    super("The dm+d load took longer than its time limit.");
    this.name = "DmdLoadTimeout";
  }
}

export interface DmdParseLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  /** `Date.now()` past which the parse stops with `DmdLoadTimeout`. */
  readonly deadline: number;
}

/** Lets the event loop run other work (the worker's other queues) between chunks. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Reads a release's files in name order, each streamed through its XML reader a chunk at a time,
 * never whole, and checks the limits first: more files or bytes than allowed refuse the release
 * before anything is read (`too_large`). The checksum (SHA-256 over every file's name and content,
 * in name order) is taken as the chunks pass. Problems here (a file missing, repeated or
 * unreadable, a section naming a product the file does not hold) refuse the release before
 * `checkDmdRelease` runs. Throws `DmdLoadTimeout` past the deadline.
 */
export async function parseDmdRelease(
  release: DmdReleaseFiles,
  limits: DmdParseLimits,
): Promise<ParsedDmdRelease> {
  const problems: DmdReleaseProblem[] = [];
  const bytes = release.files.reduce((sum, f) => sum + f.bytes, 0);
  if (release.files.length > limits.maxFiles || bytes > limits.maxBytes) {
    const problem: DmdReleaseProblem = {
      code: "too_large",
      file: null,
      id: null,
      message: `The release has ${release.files.length} files and ${bytes} bytes; at most ${limits.maxFiles} files and ${limits.maxBytes} bytes are read.`,
    };
    return { content: null, problems: [problem], problemCount: 1, fileCounts: {}, checksum: null };
  }

  const kindOf = new Map<string, DmdReleaseFile>();
  let ignored = 0;
  for (const file of release.files) {
    const match = FILE_NAME.exec(file.name);
    if (!match) {
      ignored += 1;
      continue;
    }
    const kind = match[1] as DmdReleaseFile;
    if ([...kindOf.values()].includes(kind)) {
      problems.push({
        code: "file_repeated",
        file: kind,
        id: null,
        message: `The release has more than one ${kind} file.`,
      });
      continue;
    }
    kindOf.set(file.name, kind);
  }
  for (const kind of DMD_RELEASE_FILES) {
    if (![...kindOf.values()].includes(kind)) {
      problems.push({
        code: "file_missing",
        file: kind,
        id: null,
        message: `The release has no ${kind} file.`,
      });
    }
  }

  const records = new Map<DmdReleaseFile, Records>();
  const hash = createHash("sha256");
  const ordered = [...release.files].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const file of ordered) {
    hash.update(file.name).update("\0");
    const kind = kindOf.get(file.name);
    const reader = kind === undefined ? null : new RecordReader(ROOTS[kind], SPECS[kind]);
    let failed: string | null = null;
    try {
      for await (const chunk of file.chunks()) {
        if (Date.now() >= limits.deadline) throw new DmdLoadTimeout();
        hash.update(chunk);
        if (reader !== null && failed === null) {
          try {
            reader.write(chunk);
          } catch (error) {
            failed = (error as Error).message;
          }
        }
        await yieldToEventLoop();
      }
    } catch (error) {
      // A file that is not UTF-8, or grows while it is read, is unreadable: the release is refused.
      if (error instanceof DmdLoadTimeout) throw error;
      problems.push({
        code: "unreadable_xml",
        file: kind ?? null,
        id: null,
        message: `${file.name} could not be read: ${(error as Error).message}`.slice(0, 300),
      });
      continue;
    }
    hash.update("\0");
    if (kind === undefined || reader === null) continue;
    if (failed === null) {
      try {
        records.set(kind, reader.end());
      } catch (error) {
        failed = (error as Error).message;
      }
    }
    if (failed !== null) {
      problems.push({
        code: "unreadable_xml",
        file: kind,
        id: null,
        message: `The ${kind} file is not readable dm+d XML: ${failed}`.slice(0, 300),
      });
    }
  }

  const take = <T>(kind: DmdReleaseFile, fn: (r: Records) => T[]): T[] => {
    const found = records.get(kind);
    return found === undefined ? [] : fn(found);
  };
  const lookups = take("lookup", readLookups);
  const vtms = take("vtm", readVtms);
  const vmps = take("vmp", (r) => readVmps(r, problems));
  const amps = take("amp", (r) => readAmps(r, problems));
  const vmpps = take("vmpp", readVmpps);
  const ampps = take("ampp", readAmpps);
  const gtins = take("gtin", readGtins);

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
    checksum: hash.digest("hex"),
  };
}
