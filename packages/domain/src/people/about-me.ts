/**
 * PRSB About Me v2.01 (master prompt section 9.2; data-standards.md `about_me`; people.md section 4
 * rule 9). The person writes About Me in their own words, or someone supports them and is named in
 * "Supported to write this by". The JSON shape matches the stored document: one key per PRSB
 * section plus the two record-level items. Media is always a reference to a document (never
 * inline). Sharing About Me outside the home needs a sharing decision (sharing.ts).
 */

export const ABOUT_ME_SECTIONS = [
  {
    key: "what_is_most_important_to_me",
    title: "What is most important to me",
    snomedHeading: "1515861000000103",
  },
  {
    key: "people_who_are_important_to_me",
    title: "People who are important to me",
    snomedHeading: "1515871000000105",
  },
  {
    key: "how_i_communicate",
    title: "How I communicate and how to communicate with me",
    snomedHeading: "1515881000000107",
  },
  { key: "my_wellness", title: "My wellness", snomedHeading: "1515891000000109" },
  {
    key: "please_do_and_please_do_not",
    title: "Please do and please do not",
    snomedHeading: "1515901000000105",
  },
  {
    key: "how_and_when_to_support_me",
    title: "How and when to support me",
    snomedHeading: "1515911000000107",
  },
  {
    key: "also_worth_knowing_about_me",
    title: "Also worth knowing about me",
    snomedHeading: "1515921000000101",
  },
] as const;

export type AboutMeSectionKey = (typeof ABOUT_ME_SECTIONS)[number]["key"];

export interface AboutMeMedia {
  readonly documentId: string;
  readonly mimeType: string;
  readonly filename?: string;
}

export interface AboutMeSectionContent {
  readonly text?: string | null;
  readonly media?: readonly AboutMeMedia[];
}

/** The stored About Me document (snake_case keys, as in data-standards.md). */
export type AboutMeDocument = {
  readonly [K in AboutMeSectionKey]?: AboutMeSectionContent | null;
} & {
  readonly supported_to_write_this_by?: string | null;
  readonly date_last_updated?: string | null;
};

const RECORD_LEVEL_KEYS = ["supported_to_write_this_by", "date_last_updated"];

function isSectionKey(key: string): key is AboutMeSectionKey {
  return ABOUT_ME_SECTIONS.some((s) => s.key === key);
}

function hasContent(content: AboutMeSectionContent | null | undefined): boolean {
  if (!content) return false;
  return (content.text?.trim().length ?? 0) > 0 || (content.media?.length ?? 0) > 0;
}

/** Sections with words or media, in PRSB order. */
export function aboutMeFilledSections(document: AboutMeDocument): AboutMeSectionKey[] {
  return ABOUT_ME_SECTIONS.map((s) => s.key).filter((key) => hasContent(document[key]));
}

export type AboutMeIssue =
  | { readonly kind: "unknown_section"; readonly key: string }
  | { readonly kind: "inline_media"; readonly section: AboutMeSectionKey }
  | { readonly kind: "supporter_required" }
  | { readonly kind: "invalid_update_time" };

export interface AboutMeAuthoring {
  /** True when the person wrote it themselves without help. */
  readonly authoredByPerson: boolean;
}

/**
 * Checks an About Me document before it is saved. Every section is optional; an empty document is
 * valid (it simply has nothing to share yet).
 */
export function validateAboutMe(
  document: Readonly<Record<string, unknown>>,
  authoring: AboutMeAuthoring,
): AboutMeIssue[] {
  const issues: AboutMeIssue[] = [];
  for (const key of Object.keys(document)) {
    if (!isSectionKey(key) && !RECORD_LEVEL_KEYS.includes(key)) {
      issues.push({ kind: "unknown_section", key });
    }
  }
  const typed = document as AboutMeDocument;
  for (const section of ABOUT_ME_SECTIONS) {
    const media = typed[section.key]?.media ?? [];
    if (media.some((m) => typeof m.documentId !== "string" || m.documentId.trim().length === 0)) {
      issues.push({ kind: "inline_media", section: section.key });
    }
  }
  if (!authoring.authoredByPerson && (typed.supported_to_write_this_by?.trim().length ?? 0) === 0) {
    issues.push({ kind: "supporter_required" });
  }
  const updated = typed.date_last_updated;
  if (updated !== undefined && updated !== null && Number.isNaN(Date.parse(updated))) {
    issues.push({ kind: "invalid_update_time" });
  }
  return issues;
}

export interface AboutMeSummary {
  readonly filled: readonly AboutMeSectionKey[];
  readonly missing: readonly AboutMeSectionKey[];
  readonly dateLastUpdated: Date | null;
  /** True when at least one section has the person's words or media. */
  readonly hasContent: boolean;
}

/** What About Me holds, for the record header, the transfer pack and the review scheduler. */
export function summariseAboutMe(document: AboutMeDocument | null): AboutMeSummary {
  const filled = document ? aboutMeFilledSections(document) : [];
  const updated = document?.date_last_updated ? new Date(document.date_last_updated) : null;
  return {
    filled,
    missing: ABOUT_ME_SECTIONS.map((s) => s.key).filter((k) => !filled.includes(k)),
    dateLastUpdated: updated && !Number.isNaN(updated.getTime()) ? updated : null,
    hasContent: filled.length > 0,
  };
}
