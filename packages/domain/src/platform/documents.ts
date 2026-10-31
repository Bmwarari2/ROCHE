/**
 * Document store rules (section 9.1, ASVS 5.0 V5). Every upload is checked by content, not by its
 * name or declared type: the first bytes must match an allowed type for the category, the size must
 * be within the category's limit, and the file name is reduced to a safe display label. Documents
 * are versioned and signed with a typed name; a signature binds the exact bytes (SHA-256) signed.
 */

export const DOCUMENT_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export type DocumentContentType = (typeof DOCUMENT_CONTENT_TYPES)[number];

const IMAGES: readonly DocumentContentType[] = ["image/jpeg", "image/png", "image/webp"];
const MB = 1024 * 1024;

export interface DocumentCategory {
  readonly label: string;
  readonly contentTypes: readonly DocumentContentType[];
  readonly maxBytes: number;
  /** Documents about a person follow the person's scope and the care record's retention. */
  readonly personRequired: boolean;
  readonly retentionClass: string;
  /** Shown in the page (photos) rather than downloaded. */
  readonly inline: boolean;
}

export const DOCUMENT_CATEGORIES = {
  person_photo: {
    label: "Photo for identification",
    contentTypes: IMAGES,
    maxBytes: 10 * MB,
    personRequired: true,
    retentionClass: "care_record",
    inline: true,
  },
  /**
   * A photo chosen for the family feed (comms.md rule 6; HZ-022, HZ-060): the only photos that can
   * be published. Identification photos, wound photos and other care attachments never can.
   */
  feed_photo: {
    label: "Photo for the family feed",
    contentTypes: IMAGES,
    maxBytes: 10 * MB,
    personRequired: true,
    retentionClass: "care_record",
    inline: true,
  },
  care_attachment: {
    label: "Care record attachment (wound photo, chart scan)",
    contentTypes: [...IMAGES, "application/pdf"],
    maxBytes: 15 * MB,
    personRequired: true,
    retentionClass: "care_record",
    inline: true,
  },
  person_document: {
    label: "Document about a person (letters, legal authority, assessments by others)",
    contentTypes: [...IMAGES, "application/pdf"],
    maxBytes: 25 * MB,
    personRequired: true,
    retentionClass: "care_record",
    inline: false,
  },
  organisation_document: {
    label: "Organisation document (policies, statement of purpose, templates)",
    contentTypes: ["application/pdf"],
    maxBytes: 25 * MB,
    personRequired: false,
    retentionClass: "organisation_document",
    inline: false,
  },
  /**
   * The organisation's white-label logo (PLAT-002): shown in the shell's app bar to every member,
   * so small and image only (never SVG, which can carry script). About no one.
   */
  organisation_logo: {
    label: "Organisation logo",
    contentTypes: IMAGES,
    maxBytes: 512 * 1024,
    personRequired: false,
    retentionClass: "organisation_document",
    inline: true,
  },
} as const satisfies Record<string, DocumentCategory>;

export type DocumentCategoryKey = keyof typeof DOCUMENT_CATEGORIES;

export function isDocumentCategory(value: string): value is DocumentCategoryKey {
  return Object.hasOwn(DOCUMENT_CATEGORIES, value);
}

/** The type the bytes really are, from their signature, or null when not an allowed type. */
export function sniffContentType(bytes: Uint8Array): DocumentContentType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (bytes.length >= 3 && starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  if (
    bytes.length >= 12 &&
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 5 && starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return null;
}

export type UploadProblem =
  | "empty"
  | "too_large"
  | "type_not_allowed"
  | "type_mismatch"
  | "person_required"
  | "person_not_allowed";

export type UploadCheck =
  | { readonly ok: true; readonly contentType: DocumentContentType }
  | { readonly ok: false; readonly problem: UploadProblem; readonly message: string };

const MESSAGES: Record<UploadProblem, (category: DocumentCategory) => string> = {
  empty: () => "The file is empty.",
  too_large: (c) => `Files of this kind must be ${Math.round(c.maxBytes / MB)} MB or smaller.`,
  type_not_allowed: (c) =>
    `This kind of document must be ${c.contentTypes.map(describeType).join(" or ")}.`,
  type_mismatch: () => "The file's contents do not match its type. Save it again and retry.",
  person_required: () => "Choose the person this document is about.",
  person_not_allowed: () => "Organisation documents are not about a person.",
};

function describeType(type: DocumentContentType): string {
  return {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WebP",
    "application/pdf": "PDF",
  }[type];
}

export function checkUpload(
  category: DocumentCategoryKey,
  input: {
    readonly bytes: Uint8Array;
    readonly declaredType: string | null;
    readonly hasPerson: boolean;
  },
): UploadCheck {
  const rules: DocumentCategory = DOCUMENT_CATEGORIES[category];
  const fail = (problem: UploadProblem): UploadCheck => ({
    ok: false,
    problem,
    message: MESSAGES[problem](rules),
  });
  if (rules.personRequired && !input.hasPerson) return fail("person_required");
  if (!rules.personRequired && input.hasPerson) return fail("person_not_allowed");
  if (input.bytes.length === 0) return fail("empty");
  if (input.bytes.length > rules.maxBytes) return fail("too_large");
  const sniffed = sniffContentType(input.bytes);
  if (!sniffed || !rules.contentTypes.includes(sniffed)) return fail("type_not_allowed");
  const declared = input.declaredType?.split(";")[0]?.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== sniffed)
    return fail("type_mismatch");
  return { ok: true, contentType: sniffed };
}

const RESERVED_FILENAME_CHARACTERS = new Set(["<", ">", ":", '"', "|", "?", "*"]);

/** Longest display file name kept (the stored object key never uses it). */
export const MAX_FILENAME_LENGTH = 120;

/**
 * A safe display name: no path, no control or reserved characters, no leading dots, trimmed to
 * MAX_FILENAME_LENGTH while keeping the extension. Returns null when nothing usable is left.
 */
export function safeFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f && !RESERVED_FILENAME_CHARACTERS.has(ch);
    })
    .join("")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

/** The statement a signer agrees to when no other is given. */
export const DEFAULT_SIGNATURE_STATEMENT = "I have read this document and I agree to it.";

export type SignatureProblem = "name_required" | "statement_required" | "document_changed";

export type SignatureCheck =
  | { readonly ok: true; readonly signerName: string; readonly statement: string }
  | { readonly ok: false; readonly problem: SignatureProblem; readonly message: string };

/**
 * Checks a typed-name e-signature (section 9.1): a name of at least two characters, a statement,
 * and the hash of the bytes the signer saw, which must match the current version.
 */
export function checkSignature(input: {
  readonly typedName: string;
  readonly statement?: string | null;
  readonly sha256Seen: string;
  readonly currentSha256: string;
}): SignatureCheck {
  const name = input.typedName.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 120) {
    return { ok: false, problem: "name_required", message: "Type your full name to sign." };
  }
  const statement = (input.statement ?? DEFAULT_SIGNATURE_STATEMENT).trim();
  if (statement.length < 10) {
    return { ok: false, problem: "statement_required", message: "Say what you are agreeing to." };
  }
  if (input.sha256Seen.toLowerCase() !== input.currentSha256.toLowerCase()) {
    return {
      ok: false,
      problem: "document_changed",
      message: "The document has changed since you opened it. Read the new version before signing.",
    };
  }
  return { ok: true, signerName: name, statement };
}
