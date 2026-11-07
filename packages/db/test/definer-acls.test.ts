import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";

/**
 * Every SECURITY DEFINER function runs with its owner's rights, so who may execute it is the
 * whole of its access control (ADR-0002). Migrated as production is (by harbour_owner, never a
 * superuser), no definer function may be executable by PUBLIC, and each may be executed only by
 * the roles listed here, besides its owner. A new definer function fails this test until it is
 * listed, so its execute rights are decided, not inherited. Trigger functions are left out: they
 * can only run as triggers, never be called.
 */

/** Keyed by full signature (argument types as `oidvectortypes` prints them), so an overload is
 * listed and decided on its own. */
const EXECUTE: Readonly<Record<string, readonly string[]>> = {
  "app.accept_invitation(text, text)": ["harbour_app"],
  "app.admit_handed_over_entry(uuid, uuid, uuid, uuid, text, uuid, timestamp with time zone, integer)":
    ["harbour_app"],
  "app.auth_user_has_membership(text)": ["harbour_invitation_owner"],
  // The agency access window (ADR-0088, migration 0104), read by row-level security.
  // The agency window binds the definer owners that read role rows too (migrations 0118, 0139).
  "app.agency_access_open(uuid, uuid)": [
    "harbour_app",
    "harbour_care_definer",
    "harbour_import_owner",
    "harbour_invitation_owner",
    "harbour_member_owner",
    "harbour_owner",
    "harbour_platform_definer",
    "harbour_quality_reader",
    "harbour_sample_owner",
    "harbour_silo_owner",
    "harbour_wellbeing_owner",
    "harbour_workforce_definer",
  ],
  "app.member_is_agency(uuid)": [
    "harbour_app",
    "harbour_care_definer",
    "harbour_import_owner",
    "harbour_invitation_owner",
    "harbour_member_owner",
    "harbour_owner",
    "harbour_platform_definer",
    "harbour_quality_reader",
    "harbour_sample_owner",
    "harbour_silo_owner",
    "harbour_wellbeing_owner",
    "harbour_workforce_definer",
  ],
  // Whose working time an approver reads (migration 0109).
  "app.reads_worker_time(uuid)": ["harbour_app", "harbour_owner"],
  // A pay run's state for its lines' policies (migration 0116).
  "app.has_locked_pay_line(uuid)": ["harbour_app", "harbour_owner"],
  "app.pay_run_calculation(uuid)": ["harbour_app", "harbour_owner"],
  "app.pay_run_status(uuid)": ["harbour_app", "harbour_owner"],
  "app.claim_invitation(text)": ["harbour_app"],
  "app.pulse_survey_results(uuid)": ["harbour_app"],
  "app.submit_pulse_response(uuid, jsonb)": ["harbour_app"],
  "app.evidence_pack_link_for_token(text)": ["harbour_app"],
  "app.family_can_see(uuid, text, text, timestamp with time zone)": [
    "harbour_app",
    "harbour_owner",
  ],
  "app.family_item_shown(uuid)": ["harbour_app", "harbour_owner"],
  "app.invitation_for_token(text)": ["harbour_app"],
  "app.works_at(uuid, uuid)": ["harbour_app", "harbour_owner"],
  "app.invite_first_owner(uuid, text)": ["harbour_operator"],
  "app.memberships_for_auth_user(text)": ["harbour_app"],
  "app.provision_tenant(jsonb, jsonb, jsonb)": ["harbour_operator", "harbour_owner"],
  "app.record_invitation_sign_in(text, text)": ["harbour_app"],
  "app.seed_discard_reasons(uuid)": ["harbour_owner"],
  // Supervision notes (slice 57, migration 0114): read rule of supervision_note.
  "app.supervises_member(uuid)": ["harbour_app", "harbour_owner"],
  "app.supervision_in_force(uuid)": ["harbour_app", "harbour_owner"],
  // H-804 (migration 0121): Thapsus support appoints a case manager on an approved ticket.
  "app.operator_appoint_case_manager(uuid, uuid)": ["harbour_operator", "harbour_owner"],
  // H-805 (migration 0121): the cases a staff subject access request must collect, by id.
  "app.casework_for_subject_access(uuid)": ["harbour_app", "harbour_owner"],
  // The round gate data (migration 0071): called only by its own definer trigger functions.
  "app.refresh_earlier_plan(uuid, uuid[])": ["harbour_owner"],
  "app.task_from_earlier_plan(uuid, uuid)": ["harbour_owner"],
  // Applicant tracking (migration 0085): equality monitoring counts, never rows (rule 12).
  "app.equality_monitoring_counts(uuid)": ["harbour_app", "harbour_owner"],
  // Employee relations casework (migration 0101): whether the session's member is on a case.
  "app.casework_member(uuid, text[])": ["harbour_app", "harbour_owner"],
  "app.open_employee_case(text, uuid, text, date)": ["harbour_app", "harbour_owner"],
  // Induction and leavers (migration 0091): the profile's member, read-and-sign counts, ending a
  // leaver's access.
  "app.staff_profile_worker(uuid)": ["harbour_app", "harbour_owner"],
  "app.induction_policy_signing(uuid)": ["harbour_app", "harbour_owner"],
  "app.end_leaver_access(uuid)": ["harbour_app", "harbour_owner"],
  // Membership changes held by the database (migration 0129, H-566).
  "app.change_membership(uuid, text)": ["harbour_app"],
  "app.sign_in_memberships_elsewhere(uuid)": ["harbour_app"],
  "app.sweep_expired_invitations()": ["harbour_worker"],
  "app.unlinked_invitation_sign_ins()": ["harbour_worker"],
  // Sub-processor notices (#95, migration 0067).
  "app.announce_sub_processor_notice(text, text, jsonb, timestamp with time zone, uuid[], text)": [
    "harbour_operator",
  ],
  "app.sub_processor_objections(uuid, text)": ["harbour_operator"],
  "app.resolve_sub_processor_objection(uuid, uuid, text, text)": ["harbour_operator"],
  // Processor breach notices (slice 20, migration 0082).
  "app.send_processor_breach_notice(uuid, uuid, text, text, integer, integer, text, text, text, text, text)":
    ["harbour_operator"],
  // The quality dashboard's counts (slice 47, migration 0108): the API, for a member holding
  // quality.audit.manage at the location, which the function checks itself.
  "app.quality_indicator_counts(uuid, date, date, integer)": ["harbour_app"],
  // Sample data mode (#98, migration 0069).
  "app.sample_people()": ["harbour_app"],
  // Cover needs at any home of the organisation (HZ-123, migration 0107).
  "app.raise_cover_need(uuid, uuid)": ["harbour_app", "harbour_owner"],
  // Cover needs for Thapsus-HR absences, raised by the link's sync (migration 0142).
  "app.raise_hr_cover_need(uuid, uuid)": ["harbour_app", "harbour_owner"],
  // A reinstated member given a real leaving by the link's sync (migration 0142); no caller since
  // batch 3c refuses withdrawing a leaving once access has ended (migration 0144).
  "app.end_relinked_leaver_access(uuid)": ["harbour_owner"],
  "app.absence_member(uuid)": ["harbour_app", "harbour_owner"],
  "app.remove_sample_batch(uuid, text)": ["harbour_app"],
  // Import wizard (Phase 2 slice 26, migration 0088).
  "app.undo_import_batch(uuid, text)": ["harbour_app"],
  // The speak-up silo (ADR-0089, migration 0086).
  "app.raise_speak_up(uuid, text, text, text)": ["harbour_app"],
  "app.set_speak_up_lead(uuid, boolean)": ["harbour_app"],
  // Runs as harbour_silo_owner so speak-up events hidden from the reader still verify.
  "app.verify_audit_chain()": ["harbour_app", "harbour_owner"],
  // Single sign-on (migration 0095): the callback's facts and the invited member's link.
  "app.sso_sign_in_facts(text, text)": ["harbour_app"],
  "app.link_sso_member(text, text)": ["harbour_app"],
  "app.sso_key_ref(text)": ["harbour_app"],
  // The dm+d release loader (Phase 2 slice 10, migration 0110, ADR-0080): the dm+d job's own
  // role (migration 0131, slice 75) and a manual run by the owner; never the application or the
  // worker.
  "app.dmd_begin_release(text, date, text, text, jsonb)": ["harbour_dmd_job", "harbour_owner"],
  "app.dmd_load_rows(uuid, text, jsonb)": ["harbour_dmd_job", "harbour_owner"],
  "app.dmd_finish_release(uuid)": ["harbour_dmd_job", "harbour_owner"],
  "app.dmd_record_refusal(text, date, text, text, text, jsonb, jsonb, integer)": [
    "harbour_dmd_job",
    "harbour_owner",
  ],
};

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

type Definer = { name: string; owner: string; public: boolean; grantees: string[] };

async function definers(): Promise<Definer[]> {
  const { rows } = await db.pool("harbour_owner").query<Definer>(
    `SELECT n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS name,
            pg_get_userbyid(p.proowner) AS owner,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public,
            coalesce(array(SELECT DISTINCT pg_get_userbyid(a.grantee)
                             FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                            WHERE a.grantee <> 0 AND a.grantee <> p.proowner
                              AND a.privilege_type = 'EXECUTE'
                            ORDER BY 1)::text[], '{}') AS grantees
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND p.prorettype <> 'trigger'::regtype
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1`,
  );
  return rows;
}

describe("hazard HZ-011 definer functions run only for the roles meant to call them", () => {
  it("has definer functions to check, each listed here", async () => {
    const found = await definers();
    expect(found.length).toBeGreaterThan(10);
    expect(found.map((f) => f.name).filter((name) => !(name in EXECUTE))).toEqual([]);
  });

  it("lists only functions that exist and are SECURITY DEFINER, by full signature", async () => {
    const found = new Set((await definers()).map((f) => f.name));
    expect(Object.keys(EXECUTE).filter((name) => !found.has(name))).toEqual([]);
  });

  it("lets PUBLIC execute none of them", async () => {
    expect((await definers()).filter((f) => f.public).map((f) => f.name)).toEqual([]);
  });

  it("lets only the listed roles execute each, besides its owner", async () => {
    for (const f of await definers()) {
      expect({ name: f.name, grantees: f.grantees }).toEqual({
        name: f.name,
        grantees: [...(EXECUTE[f.name] ?? [])].sort(),
      });
    }
  });
});

/**
 * ADR-0133 (migration 0154): every security-definer function, trigger functions included, is
 * owned by a NOLOGIN role that is not a superuser, so a flaw in one never runs with a login role's
 * rights (harbour_owner, the migrator, owns every table); and pins its search_path with pg_temp
 * last, so no temporary object can shadow a name it uses.
 */
describe("ADR-0133 definer functions are owned by NOLOGIN roles and pin their search_path", () => {
  type Owned = { name: string; owner: string; login: boolean; superuser: boolean; config: string };
  const owned = async () =>
    (
      await db.pool("harbour_owner").query<Owned>(
        `SELECT p.oid::regprocedure::text AS name, r.rolname AS owner, r.rolcanlogin AS login,
                r.rolsuper AS superuser, coalesce(array_to_string(p.proconfig, ';'), '') AS config
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY 1`,
      )
    ).rows;

  it("has no definer function owned by a role that can log in, or by a superuser", async () => {
    const found = await owned();
    expect(found.length).toBeGreaterThan(50);
    expect(
      found.filter((f) => f.login || f.superuser).map((f) => `${f.name} (${f.owner})`),
    ).toEqual([]);
  });

  it("pins every definer function's search_path, with pg_temp last", async () => {
    const pinned = (config: string) =>
      config
        .split(";")
        .some((setting) => /^search_path=pg_catalog, public(, [a-z_]+)*, pg_temp$/.test(setting));
    expect((await owned()).filter((f) => !pinned(f.config)).map((f) => f.name)).toEqual([]);
  });
});
