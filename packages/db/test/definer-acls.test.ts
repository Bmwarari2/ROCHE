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
  "app.provision_tenant(jsonb, jsonb, jsonb)": ["harbour_operator"],
  "app.record_invitation_sign_in(text, text)": ["harbour_app"],
  "app.seed_discard_reasons(uuid)": ["harbour_owner"],
  // A person's home and status for the sync routing columns (migration 0146; ADR-0134): called
  // only by the routing triggers, which run as their owner.
  "app.sync_person(uuid, uuid)": [],
  // Supervision notes (slice 57, migration 0114): read rule of supervision_note.
  "app.supervises_member(uuid)": ["harbour_app", "harbour_owner"],
  "app.supervision_in_force(uuid)": ["harbour_app", "harbour_owner"],
  // H-804 (migration 0121): Thapsus support appoints a case manager on an approved ticket.
  "app.operator_appoint_case_manager(uuid, uuid)": ["harbour_operator"],
  // H-805 (migration 0121): the cases a staff subject access request must collect, by id.
  "app.casework_for_subject_access(uuid)": ["harbour_app"],
  // The round gate data (migration 0071): called only by its own definer trigger functions.
  "app.refresh_earlier_plan(uuid, uuid[])": ["harbour_owner"],
  "app.task_from_earlier_plan(uuid, uuid)": [],
  // Applicant tracking (migration 0085): equality monitoring counts, never rows (rule 12).
  "app.equality_monitoring_counts(uuid)": ["harbour_app"],
  // Employee relations casework (migration 0101): whether the session's member is on a case.
  "app.casework_member(uuid, text[])": ["harbour_app", "harbour_owner"],
  "app.open_employee_case(text, uuid, text, date)": ["harbour_app"],
  // Induction and leavers (migration 0091): the profile's member, read-and-sign counts, ending a
  // leaver's access.
  "app.staff_profile_worker(uuid)": ["harbour_app", "harbour_owner"],
  // The Care Certificate from a member's training record, for observers (migration 0154).
  "app.care_certificate_profile(uuid)": ["harbour_app"],
  "app.induction_policy_signing(uuid)": ["harbour_app"],
  "app.end_leaver_access(uuid)": ["harbour_app"],
  // Membership changes held by the database (migration 0129, H-566).
  // The member lifecycle completed (migration 0149): the erasure sweep's reads, and the member's
  // own request.
  "app.sign_in_erasure_due(text)": [],
  "app.sign_ins_due_for_erasure()": ["harbour_worker"],
  "app.request_sign_in_erasure()": ["harbour_app"],
  "app.change_membership(uuid, text)": ["harbour_app", "harbour_worker"],
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
  "app.raise_cover_need(uuid, uuid)": ["harbour_app"],
  // Cover needs for Thapsus-HR absences, raised by the link's sync (migration 0142).
  "app.raise_hr_cover_need(uuid, uuid)": ["harbour_app"],
  // A reinstated member given a real leaving by the link's sync (migration 0142); no caller since
  // batch 3c refuses withdrawing a leaving once access has ended (migration 0144).
  "app.end_relinked_leaver_access(uuid)": [],
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
 * ADR-0133 (migration 0151): every Harbour security-definer function, trigger functions included,
 * is owned by a NOLOGIN role that is not a superuser, cannot bypass row-level security and is not a
 * member of a role that can log in, so a flaw in one never runs with a login role's rights
 * (harbour_owner, the migrator, owns every table); and pins its search_path with pg_temp last, so
 * no temporary object can shadow a name it uses. Extension members (pgAudit's event-trigger
 * functions, a hosting platform's own) belong to their extension and are left out, as 0151 leaves
 * them.
 */
const DEFINER_ROLES = [
  "harbour_care_definer",
  "harbour_finance_definer",
  "harbour_platform_definer",
  "harbour_scheduling_definer",
  "harbour_workforce_definer",
] as const;

describe("ADR-0133 definer functions are owned by NOLOGIN roles and pin their search_path", () => {
  type Owned = {
    name: string;
    owner: string;
    login: boolean;
    superuser: boolean;
    bypassrls: boolean;
    loginMember: boolean;
    config: string;
  };
  const owned = async () =>
    (
      await db.pool("harbour_owner").query<Owned>(
        `SELECT p.oid::regprocedure::text AS name, r.rolname AS owner, r.rolcanlogin AS login,
                r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
                EXISTS (SELECT 1 FROM pg_roles l
                         WHERE l.rolcanlogin AND l.oid <> r.oid
                           AND pg_has_role(r.oid, l.oid, 'MEMBER')) AS "loginMember",
                coalesce(array_to_string(p.proconfig, ';'), '') AS config
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.prosecdef AND n.nspname IN ('app', 'public', 'auth')
            AND NOT EXISTS (SELECT 1 FROM pg_depend d
                             WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                               AND d.deptype = 'e')
          ORDER BY 1`,
      )
    ).rows;

  it("has no definer function owned by a role that can log in, or acts as one", async () => {
    const found = await owned();
    expect(found.length).toBeGreaterThan(50);
    expect(
      found
        .filter((f) => f.login || f.superuser || f.bypassrls || f.loginMember)
        .map((f) => `${f.name} (${f.owner})`),
    ).toEqual([]);
  });

  it("pins every definer function's search_path, with pg_temp last", async () => {
    const pinned = (config: string) =>
      config
        .split(";")
        .some((setting) => /^search_path=pg_catalog(, [a-z_]+)*, pg_temp$/.test(setting));
    expect((await owned()).filter((f) => !pinned(f.config)).map((f) => f.name)).toEqual([]);
  });

  it("holds every context definer in each restrictive policy that holds harbour_owner", async () => {
    // A definer function runs as its owner, so a restrictive policy written for harbour_owner
    // alone would not bind the context definers: add them to it (see 0151).
    const { rows } = await db.pool("harbour_owner").query<{ policy: string; missing: string[] }>(
      `SELECT format('%s on %s', pol.polname, pol.polrelid::regclass) AS policy,
              array(SELECT d FROM unnest($1::text[]) d
                     WHERE NOT d::regrole::oid = ANY (pol.polroles) ORDER BY d) AS missing
         FROM pg_policy pol
        WHERE NOT pol.polpermissive AND 'harbour_owner'::regrole::oid = ANY (pol.polroles)`,
      [DEFINER_ROLES],
    );
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((r) => r.missing.length > 0)).toEqual([]);
  });
});

/**
 * ADR-0133: each context definer holds only the table privileges its functions use, and what the
 * row-level policies and invoker triggers of those tables read as it. A new grant is a decision:
 * add it here with the function that needs it.
 */
const DEFINER_TABLE_GRANTS: Readonly<Record<(typeof DEFINER_ROLES)[number], readonly string[]>> = {
  harbour_care_definer: [
    "public.access_grant: SELECT",
    "public.break_glass_event: SELECT",
    "public.care_plan: SELECT",
    "public.care_plan_action: SELECT",
    "public.discard_reason: SELECT, INSERT",
    "public.handed_over_entry: SELECT, INSERT",
    "public.handover: SELECT",
    "public.location: SELECT",
    "public.person: SELECT",
    "public.person_assignment: SELECT",
    "public.record_version: INSERT",
    "public.role: SELECT",
    "public.role_assignment: SELECT",
    "public.task: SELECT, UPDATE",
    "public.task_series: SELECT",
    "public.tenant: SELECT",
  ],
  harbour_finance_definer: ["public.pay_run: SELECT", "public.pay_run_line: SELECT"],
  harbour_platform_definer: [
    "app.audit_chain_head: SELECT, INSERT, UPDATE",
    // The sync routing functions (migration 0146): what the row-level policies of the tables
    // they read and move evaluate as this role. Their own reads and moves are column grants
    // (see the next test).
    "public.access_grant: SELECT",
    "public.break_glass_event: SELECT",
    "public.location: SELECT",
    "public.person_assignment: SELECT",
    "public.record_version: INSERT",
    "public.role: SELECT, INSERT",
    "public.role_assignment: SELECT, INSERT",
    "public.tenant: SELECT, INSERT",
    "public.tenant_user: SELECT, INSERT",
  ],
  harbour_scheduling_definer: [
    "public.absence: SELECT",
    "public.access_grant: SELECT",
    "public.agency: SELECT",
    "public.agency_booking: SELECT, UPDATE",
    "public.agency_worker: SELECT",
    "public.location: SELECT",
    "public.rate_table: SELECT",
    "public.record_version: INSERT",
    "public.role: SELECT",
    "public.role_assignment: SELECT",
    "public.rota: SELECT",
    "public.shift: SELECT, UPDATE",
    "public.shift_assignment: SELECT",
    "public.shift_cover_need: SELECT, INSERT",
    "public.shift_template: SELECT",
    "public.tenant_user: SELECT, UPDATE",
  ],
  harbour_workforce_definer: [
    "public.absence: SELECT",
    "public.access_grant: SELECT, UPDATE",
    "public.agency: SELECT",
    "public.casework_support_ticket: SELECT, UPDATE",
    "public.employee_case: SELECT, INSERT",
    "public.employee_case_event: SELECT, INSERT",
    "public.employee_case_member: SELECT, INSERT",
    "public.equality_monitoring: SELECT",
    "public.incident: SELECT",
    "public.interview: SELECT",
    "public.investigation: SELECT",
    "public.leaver_record: SELECT, UPDATE",
    "public.location: SELECT",
    "public.policy_signature: SELECT",
    "public.policy_version: SELECT",
    "public.record_version: INSERT",
    "public.role: SELECT",
    "public.role_assignment: SELECT, UPDATE",
    "public.staff_profile: SELECT",
    "public.supervision_record: SELECT",
    "public.tenant_user: SELECT, UPDATE",
    "public.vacancy: SELECT",
  ],
};

describe("ADR-0133 context definers hold only the grants their functions use", () => {
  it("grants each context definer exactly its listed table privileges", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ role: string; grant: string }>(
      `SELECT grantee AS role, format('%s.%s: %s', table_schema, table_name,
              string_agg(privilege_type, ', ' ORDER BY array_position(
                ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], privilege_type::text))) AS grant
         FROM information_schema.role_table_grants
        WHERE grantee = ANY ($1::text[])
        GROUP BY grantee, table_schema, table_name
        ORDER BY 1, 2`,
      [DEFINER_ROLES],
    );
    const found: Record<string, string[]> = {};
    for (const row of rows) found[row.role] = [...(found[row.role] ?? []), row.grant];
    expect(found).toEqual(DEFINER_TABLE_GRANTS);
  });
});

/**
 * Batch 4 (ADR-0133): the sync routing functions read a person's or a handover's home and move
 * only the routing columns, so their owner holds column grants, never whole tables.
 */
const PLATFORM_DEFINER_COLUMN_UPDATES = [
  "public.activity_record.sync_location_id",
  "public.assessment.sync_location_id",
  "public.body_map_mark.sync_location_id",
  "public.care_note.sync_location_id",
  "public.handover_item.at_home",
  "public.handover_item.person_location_id",
  "public.handover_note.at_home",
  "public.handover_note.person_location_id",
  "public.medication_administration.sync_location_id",
  "public.observation.sync_location_id",
  "public.task.sync_location_id",
  "public.visit_log.sync_location_id",
];

describe("ADR-0133 the sync routing definer updates only the routing columns", () => {
  it("lets harbour_platform_definer update exactly the routing columns, and no whole table", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ col: string }>(
      `SELECT format('%s.%s.%s', table_schema, table_name, column_name) AS col
         FROM information_schema.role_column_grants
        WHERE grantee = 'harbour_platform_definer' AND privilege_type = 'UPDATE'
          AND table_schema = 'public'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.col)).toEqual(PLATFORM_DEFINER_COLUMN_UPDATES);
  });
});
