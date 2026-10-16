import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Letter and email templates through the API (comms.md rules 18 to 23 and section 5; COMMS-007;
 * ADR-0051; hazard HZ-051): the merge field catalogue, drafts checked as they are saved, approval
 * never by the author or an editor, approved versions fixed, new drafts, retirement, and every
 * change audited.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface Version {
  id: string;
  state: string;
  version: number;
  issues: { problem: string; field: string | null }[];
  personalDataFields: string[];
}
interface Template {
  id: string;
  currentVersionId: string | null;
  current: Version | null;
  draft: Version | null;
}

const LETTER =
  "Dear {{recipient.full_name}},\n\n{{person.preferred_name}} joins {{location.name}} on {{admission.date}}.";

const make = async (who: string, body: Record<string, unknown>) =>
  as(who, "/v1/letter-templates", { method: "POST", body });

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-051 letter and email templates", () => {
  let template: Template;

  it("lists the merge field catalogue, and refuses a care worker", async () => {
    const fields = await as("manager", "/v1/merge-fields");
    expect(fields.status).toBe(200);
    const { items } = (await fields.json()) as { items: { key: string; dataClass: string }[] };
    expect(items.find((f) => f.key === "incident.summary")?.dataClass).toBe("special_category");
    expect((await as("carer", "/v1/merge-fields")).status).toBe(403);
    expect((await as("carer", "/v1/letter-templates")).status).toBe(403);
  });

  it("saves a draft with its problems; an email cannot carry personal details in its subject or health details", async () => {
    const email = await make("manager", {
      kind: "general",
      channel: "email",
      name: "Visit reminder",
      subject: "About {{person.preferred_name}}",
      body: "{{incident.summary}}",
    });
    expect(email.status).toBe(201);
    const made = (await email.json()) as Template;
    expect(made.draft?.issues.map((i) => i.problem).sort()).toEqual([
      "special_category_in_email",
      "subject_personal_data",
    ]);
    const approve = await as(
      "owner",
      `/v1/letter-templates/${made.id}/versions/${made.draft?.id}/approve`,
      { method: "POST", body: { version: made.draft?.version } },
    );
    expect(approve.status).toBe(422);
    const candourEmail = await make("manager", {
      kind: "duty_of_candour",
      channel: "email",
      name: "Candour",
      subject: "A letter from us",
      body: "Hello",
    });
    expect(candourEmail.status).toBe(422);
    expect(((await candourEmail.json()) as { detail: string }).detail).toContain("letters only");
  });

  it("is approved only by someone who did not write or edit it, then is fixed and in use", async () => {
    const created = await make("manager", {
      kind: "admission",
      channel: "letter",
      name: "Welcome letter",
      subject: null,
      body: LETTER,
    });
    template = (await created.json()) as Template;
    const draft = template.draft as Version;
    expect(draft.issues).toEqual([]);
    expect(draft.personalDataFields.sort()).toEqual(
      ["admission.date", "person.preferred_name", "recipient.full_name"].sort(),
    );
    const url = `/v1/letter-templates/${template.id}/versions/${draft.id}`;
    const own = await as("manager", `${url}/approve`, {
      method: "POST",
      body: { version: draft.version },
    });
    expect(own.status).toBe(403);
    // The quality lead edits it: a contributor now, so cannot approve it either.
    const edited = await as("quality", url, {
      method: "PUT",
      body: {
        name: "Welcome letter",
        subject: null,
        body: `${LETTER}\n\nWelcome.`,
        version: draft.version,
      },
    });
    expect(edited.status).toBe(200);
    const after = (await edited.json()) as Version;
    expect(
      (await as("quality", `${url}/approve`, { method: "POST", body: { version: after.version } }))
        .status,
    ).toBe(403);
    const approved = await as("owner", `${url}/approve`, {
      method: "POST",
      body: { version: after.version },
    });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as Version).state).toBe("approved");
    const fixed = await as("manager", url, {
      method: "PUT",
      body: { name: "Changed", subject: null, body: LETTER, version: after.version + 1 },
    });
    expect(fixed.status).toBe(409);
    const audits = await sql<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_event WHERE resource_id = $1 ORDER BY occurred_at",
      [template.id],
    );
    expect(audits.filter((a) => a.outcome === "success").map((a) => a.action)).toEqual([
      "comms.template.drafted",
      "comms.template.edited",
      "comms.template.approved",
    ]);
    expect(audits.some((a) => a.outcome === "denied")).toBe(true);
  });

  it("keeps the approved version in use while a new draft is written, then supersedes it", async () => {
    const started = await as("manager", `/v1/letter-templates/${template.id}/versions`, {
      method: "POST",
    });
    expect(started.status).toBe(201);
    const draft = (await started.json()) as Version;
    expect(
      (await as("manager", `/v1/letter-templates/${template.id}/versions`, { method: "POST" }))
        .status,
    ).toBe(409);
    const url = `/v1/letter-templates/${template.id}/versions/${draft.id}`;
    const same = await as("owner", `${url}/approve`, {
      method: "POST",
      body: { version: draft.version },
    });
    expect(same.status).toBe(409);
    const changed = (await (
      await as("manager", url, {
        method: "PUT",
        body: {
          name: "Welcome letter",
          subject: null,
          body: `${LETTER}\n\nWe look forward to meeting you.`,
          version: draft.version,
        },
      })
    ).json()) as Version;
    await as("owner", `${url}/approve`, { method: "POST", body: { version: changed.version } });
    const versions = (await (
      await as("manager", `/v1/letter-templates/${template.id}/versions`)
    ).json()) as { items: Version[] };
    expect(versions.items.map((v) => v.state)).toEqual(["approved", "superseded"]);
  });

  it("retires the version in use, by an approver with a reason; the template is then out of use", async () => {
    const list = (await (await as("manager", "/v1/letter-templates")).json()) as {
      items: Template[];
    };
    const mine = list.items.find((t) => t.id === template.id) as Template;
    const current = mine.current as Version;
    const url = `/v1/letter-templates/${template.id}/versions/${current.id}/retire`;
    expect(
      (
        await as("carer", url, {
          method: "POST",
          body: { reason: "Old", version: current.version },
        })
      ).status,
    ).toBe(403);
    const retired = await as("owner", url, {
      method: "POST",
      body: { reason: "Replaced by the new admission pack", version: current.version },
    });
    expect(retired.status).toBe(200);
    const [row] = await sql<{ current_version_id: string | null }>(
      "SELECT current_version_id FROM letter_template WHERE id = $1",
      [template.id],
    );
    expect(row?.current_version_id).toBeNull();
    // Reasons are typed text: the audit row keeps a code, never the words (H-223).
    const reasons = await sql<{ reason: string }>(
      "SELECT reason FROM audit_event WHERE resource_id = $1 AND action = 'comms.template.retired'",
      [template.id],
    );
    expect(reasons).toEqual([{ reason: "retired" }]);
  });
});
