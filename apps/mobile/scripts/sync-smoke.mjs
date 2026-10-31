#!/usr/bin/env node
/**
 * The phone's sync path, over the wire, without the phone (the Phase 1 mobile gate,
 * docs/plans/phase-1-gate.md section 1). Against a seeded API and PowerSync it does what Care mode
 * does when it signs in and syncs, and fails unless the data the offline flows rely on arrives:
 *
 * 1. Signs in the demo manager, as the web would, and creates a round task due now for the
 *    person the carer is assigned (`POST /v1/tasks`), so the round flow has a task to mark.
 * 2. Signs in the demo carer as the app does (`/api/auth/sign-in/email`, Origin `harbour://`,
 *    bearer token from `set-auth-token`), reads `/v1/me`, and asks for a sync token
 *    (`POST /v1/sync/token`) with a device id.
 * 3. Opens PowerSync's stream with that token and waits for a checkpoint holding the person and
 *    the task.
 *
 * It proves the API, the token's claims, the sync streams and PowerSync's replication work
 * together for a carer. It does not prove the app: the Maestro flows on an emulator do that.
 * Only the demo tenant's invented people and example.invalid accounts are used; nothing is logged
 * but opaque ids and counts.
 *
 * Usage: node apps/mobile/scripts/sync-smoke.mjs
 *   HARBOUR_API_URL (default http://localhost:4000), HARBOUR_DEMO_PASSWORD (the seed's default),
 *   HARBOUR_SMOKE_PERSON (default Ada Example's seeded id), HARBOUR_ROUND_TASK (default
 *   "Reposition"), HARBOUR_SMOKE_TIMEOUT_MS (default 60000).
 *   Prints the task id on success, as `task_id=<uuid>` (for $GITHUB_OUTPUT).
 */
import { randomUUID } from "node:crypto";

const API = (process.env.HARBOUR_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const PASSWORD = process.env.HARBOUR_DEMO_PASSWORD ?? "correct horse battery staple";
const PERSON = process.env.HARBOUR_SMOKE_PERSON ?? "0194d000-0000-7000-8600-000000000001";
const TITLE = process.env.HARBOUR_ROUND_TASK ?? "Reposition";
const TIMEOUT_MS = Number(process.env.HARBOUR_SMOKE_TIMEOUT_MS ?? 60_000);
const ORIGIN = "harbour://";

function fail(message) {
  console.error(`sync smoke: ${message}`);
  process.exit(1);
}

async function signIn(email) {
  const response = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) fail(`sign-in refused (${response.status})`);
  return token;
}

async function api(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    fail(`${init.method ?? "GET"} ${path} answered ${response.status} ${body?.code ?? ""}`);
  return body;
}

// 1. A round task due now for the person, created by the manager.
const managerToken = await signIn("manager@example.invalid");
const managerMe = await api("/v1/me", managerToken);
const tenant = { "x-harbour-tenant": managerMe.tenant.id };
const now = Date.now();
const iso = (minutes) => new Date(now + minutes * 60_000).toISOString();
const created = await api("/v1/tasks", managerToken, {
  method: "POST",
  headers: tenant,
  body: JSON.stringify({
    title: TITLE,
    personId: PERSON,
    dueAt: iso(10),
    windowStart: iso(-20),
    windowEnd: iso(40),
    priority: "routine",
  }),
});
const taskId = created.id;
if (typeof taskId !== "string") fail("the task was not created");

// 2. The carer signs in as the app does and asks for a sync token.
const carerToken = await signIn("carer@example.invalid");
const carerMe = await api("/v1/me", carerToken);
const credentials = await api("/v1/sync/token", carerToken, {
  method: "POST",
  headers: { "x-harbour-tenant": carerMe.tenant.id, "x-harbour-device": randomUUID() },
});
if (typeof credentials?.endpoint !== "string" || typeof credentials?.token !== "string") {
  fail("the sync token answer has no endpoint or token");
}

// 3. PowerSync's stream, read until a checkpoint holds both rows.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
const seen = new Map();
let complete = false;
try {
  const response = await fetch(`${credentials.endpoint.replace(/\/+$/, "")}/sync/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
      Authorization: `Token ${credentials.token}`,
    },
    body: JSON.stringify({
      buckets: [],
      include_checksum: true,
      raw_data: true,
      client_id: randomUUID(),
      streams: { include_defaults: true, subscriptions: [] },
    }),
    signal: controller.signal,
  });
  if (!response.ok || !response.body) fail(`the sync stream answered ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      for (const op of message.data?.data ?? []) {
        if (op.op === "PUT") seen.set(`${op.object_type}:${op.object_id}`, op.object_type);
      }
      if (message.checkpoint_complete || message.partial_checkpoint_complete) {
        if (seen.has(`person:${PERSON}`) && seen.has(`task:${taskId}`)) {
          complete = true;
          break;
        }
      }
    }
    if (complete) break;
  }
} catch (error) {
  if (error?.name !== "AbortError") throw error;
} finally {
  clearTimeout(timer);
  controller.abort();
}

const counts = {};
for (const type of seen.values()) counts[type] = (counts[type] ?? 0) + 1;
console.error(`sync smoke: rows by table ${JSON.stringify(counts)}`);
if (!complete) {
  fail(
    `no checkpoint held the person (${seen.has(`person:${PERSON}`)}) and the task (${seen.has(`task:${taskId}`)}) within ${TIMEOUT_MS} ms`,
  );
}
console.error("sync smoke: the carer's device received the person and the new round task");
console.log(`task_id=${taskId}`);
