import { z } from "zod";

/**
 * A member of staff as screens name them (care.md section 5, staff names; data-standards.md): the
 * display name and job title the organisation keeps for them, beside the opaque id, so a record
 * says who wrote, sent, published or acknowledged it (Regulation 17 attribution). Returned only on
 * records the caller may already read, and only for staff of the caller's organisation; null when
 * the member is not known there (for example a system job).
 */
export const StaffName = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    jobTitle: z.string().nullable(),
  })
  .meta({
    id: "StaffName",
    description:
      "A member of staff named for attribution on a record the caller may read: display name and job title",
  });
export type StaffName = z.infer<typeof StaffName>;

/**
 * Colleagues to choose from (workforce.md section 5): an interview panel, a colleague shadowed, a
 * case member. Name and job title only.
 */
export const ColleagueList = z.object({ items: z.array(StaffName) }).meta({ id: "ColleagueList" });
export type ColleagueList = z.infer<typeof ColleagueList>;
