import {
  ElearningAttempt,
  ElearningAttemptList,
  ElearningCommit,
  ElearningCourse,
  ElearningCourseList,
  ElearningCourseUploadQuery,
  ElearningLaunch,
} from "@harbour/contracts";
import {
  elearningAttempt,
  elearningCourse,
  elearningStatement,
  type Transaction,
} from "@harbour/db";
import {
  attemptOutcome,
  cmiProblem,
  completesTraining,
  contentTypeOf,
  entryNameProblem,
  nextAttemptStatus,
  sessionSeconds,
  TRAINING_TOPICS,
  XAPI_STATEMENT_MAX_BYTES,
  xapiOutcome,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  refusalOf,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { destroyingOnFailure, storeDocument } from "../services/documents";
import {
  ATTEMPT_SOURCE,
  type AttemptRow,
  asLauncher,
  COURSE_SOURCE,
  type CourseRow,
  latestAttempts,
  PackageCache,
  packageLocation,
  recordCompletion,
} from "../services/elearning";
import {
  analysePackage,
  type LaunchClaims,
  PackageProblem,
  packageFile,
  packageProblemMessage,
  signLaunchToken,
  verifyLaunchToken,
} from "../services/elearning-package";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * E-learning (workforce.md section 14; slice 43; WORK-006; ADR-0093). Training leads
 * (`workforce.training.manage`) add SCORM 1.2, SCORM 2004 and xAPI packages, checked entry by
 * entry and scanned for malware, and retire them; staff (`workforce.self.read`) start or resume
 * their own attempts, each with a signed launch token for the content origin; the app sends what
 * the runtime reports (through the postMessage protocol) as commits on the member's own attempt.
 * The token routes under `/e/launch/{token}` take no session: the token names one attempt, so
 * they serve that course's files and keep that attempt's xAPI statements, nothing else. A
 * completion or pass becomes a slice 17 training record. Audit events carry ids only.
 */

const TRAINING = "workforce.training.manage";
const SELF = "workforce.self.read";
const A = {
  added: "workforce.elearning_course.added",
  retired: "workforce.elearning_course.retired",
  started: "workforce.elearning_attempt.started",
  completed: "workforce.elearning_attempt.completed",
} as const;

const IdParam = z.object({ id: z.uuid() });
const TokenParam = z.object({ token: z.string().min(10).max(512) });
const FileParam = TokenParam.extend({ path: z.string().min(1).max(240) });

const binary = z.string().meta({ format: "binary" });
const zipBody = {
  content: {
    "application/zip": { schema: binary },
    "application/octet-stream": { schema: binary },
  },
  required: true,
} as const;

const packages = new PackageCache();

const refused = (
  problem: HttpProblem,
  action: string,
  type: string,
  id: string | null,
  reason: string,
) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: type,
    ...(id ? { resourceId: id } : {}),
    reason,
  });

async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  type: string,
  id: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!["42501", "23505", "23503", "23514"].includes(code ?? "")) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: type,
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    throw problems.invalid("That cannot be saved. Reload the page and try again.");
  }
}

function courseView(row: CourseRow, mine: AttemptRow | undefined) {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    topic: row.topic,
    tier: row.tier,
    standard: row.standard as "scorm_1_2" | "scorm_2004" | "xapi",
    status: row.status as "active" | "retired",
    fileCount: row.fileCount,
    myAttempt: mine
      ? {
          id: mine.id,
          status: mine.status as "in_progress" | "completed" | "passed" | "failed",
          score: mine.score === null ? null : Number(mine.score),
        }
      : null,
  };
}

function attemptView(row: AttemptRow) {
  return {
    id: row.id,
    courseId: row.courseId,
    workerId: row.workerId,
    status: row.status as "in_progress" | "completed" | "passed" | "failed",
    score: row.score === null ? null : Number(row.score),
    totalSeconds: row.totalSeconds,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    trainingRecordId: row.trainingRecordId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Records a completion (once) and audits it in the member's name. */
async function afterSettled(
  c: Context<AppEnv>,
  tenantId: string,
  attempt: AttemptRow,
  access: TenantAccess | null,
) {
  if (!completesTraining(attempt.status as never) || attempt.trainingRecordId) return attempt;
  const recordId = await recordCompletion(c.get("services").db, tenantId, attempt.id);
  if (recordId && access) {
    await writeAudit(c.get("services").appPool, access, {
      action: A.completed,
      resourceType: ATTEMPT_SOURCE,
      resourceId: attempt.id,
      scope: { trainingRecordId: recordId, courseId: attempt.courseId },
      requestId: c.get("requestId"),
    });
  }
  return recordId ? { ...attempt, trainingRecordId: recordId } : attempt;
}

export const elearningRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/elearning/courses",
      tags: ["workforce"],
      summary: "E-learning courses",
      description:
        "workforce.self.read or workforce.training.manage. The organisation's active courses (training leads also see retired ones), each with the reader's own latest attempt.",
      security,
      responses: { 200: jsonBody(ElearningCourseList, "Courses"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [SELF, TRAINING]);
      const lead = refusalOf(c.get("access"), TRAINING) === null;
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(elearningCourse)
          .where(
            and(
              isNull(elearningCourse.deletedAt),
              lead ? undefined : eq(elearningCourse.status, "active"),
            ),
          )
          .orderBy(elearningCourse.title);
        const mine = await latestAttempts(tx, access.tenantUserId);
        return rows.map((r) => courseView(r, mine.get(r.id)));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/elearning/courses",
      tags: ["workforce"],
      summary: "Add an e-learning course from a package",
      description:
        "workforce.training.manage. A SCORM 1.2, SCORM 2004 or xAPI zip of at most 100 MB. Every entry is checked before anything is unpacked (no path leaving the package, no links, no encrypted entries, only allowlisted file types, at most 5,000 files and 500 MB unpacked, no entry unpacking more than 100 times its size), the launch page is found from the manifest, and the archive is scanned for malware and kept in the document store. Audited.",
      security,
      request: { query: ElearningCourseUploadQuery, body: zipBody },
      responses: { 201: jsonBody(ElearningCourse, "Added"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const q = c.req.valid("query");
      if (!(TRAINING_TOPICS as readonly string[]).includes(q.topic)) {
        throw problems.invalid("Choose a training topic from the list.");
      }
      if ((q.topic === "oliver_mcgowan") !== (q.tier !== undefined)) {
        throw problems.invalid(
          "Give the tier (1 or 2) for Oliver McGowan training, and only for it.",
        );
      }
      const bytes = Buffer.from(await c.req.arrayBuffer());
      let summary: ReturnType<typeof analysePackage>;
      try {
        // Checked before any transaction opens: nothing is stored for a refused package.
        summary = analysePackage(bytes);
      } catch (error) {
        if (!(error instanceof PackageProblem)) throw error;
        await writeAudit(c.get("services").appPool, access, {
          action: A.added,
          outcome: "denied",
          resourceType: COURSE_SOURCE,
          reason: `package_${error.code}`,
          requestId: c.get("requestId"),
        });
        throw new HttpProblem(422, "package_refused", packageProblemMessage(error.code));
      }
      const { scanner } = c.get("services");
      const course = await destroyingOnFailure(c.get("services").storage, (storage) =>
        change(c, access, A.added, COURSE_SOURCE, null, async (tx) => {
          const doc = await storeDocument(tx, { storage, scanner }, access.tenantId, {
            bytes,
            declaredType: c.req.header("content-type") ?? null,
            category: "elearning_package",
            title: q.title,
            fileName: null,
            subjectType: COURSE_SOURCE,
          });
          // A package that could not be scanned is never offered to staff.
          if (doc.status !== "available") {
            throw refused(
              new HttpProblem(
                422,
                "package_not_scanned",
                "The package could not be checked for malware just now. Try again later.",
              ),
              A.added,
              COURSE_SOURCE,
              null,
              "not_scanned",
            );
          }
          const [row] = await tx
            .insert(elearningCourse)
            .values({
              title: q.title,
              topic: q.topic,
              tier: q.tier ?? null,
              standard: summary.standard,
              documentId: doc.id,
              packageSha256: doc.sha256,
              launchPath: summary.launchPath,
              launchQuery: summary.launchQuery,
              packageIdentifier: summary.identifier,
              fileCount: summary.fileCount,
              unpackedBytes: summary.unpackedBytes,
            })
            .returning();
          if (!row) throw new Error("course not stored");
          await audit(c, tx, access, {
            action: A.added,
            resourceType: COURSE_SOURCE,
            resourceId: row.id,
            scopeExtra: { documentId: doc.id, standard: row.standard },
          });
          return row;
        }),
      );
      return c.json(courseView(course, undefined), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/elearning/courses/{id}/retire",
      tags: ["workforce"],
      summary: "Retire an e-learning course",
      description:
        "workforce.training.manage. Staff are no longer offered it; attempts and training records are kept. Audited.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ElearningCourse, "Retired"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const row = await change(c, access, A.retired, COURSE_SOURCE, id, async (tx) => {
        const [updated] = await tx
          .update(elearningCourse)
          .set({ status: "retired" })
          .where(and(eq(elearningCourse.id, id), isNull(elearningCourse.deletedAt)))
          .returning();
        if (!updated) throw refused(problems.notFound(), A.retired, COURSE_SOURCE, id, "not_found");
        await audit(c, tx, access, {
          action: A.retired,
          resourceType: COURSE_SOURCE,
          resourceId: id,
        });
        return updated;
      });
      return c.json(courseView(row, undefined), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/elearning/courses/{id}/attempts",
      tags: ["workforce"],
      summary: "Attempts at an e-learning course",
      description: "workforce.training.manage. Every member's attempts, newest first.",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(ElearningAttemptList, "Attempts"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, (tx) =>
        tx
          .select()
          .from(elearningAttempt)
          .where(and(eq(elearningAttempt.courseId, id), isNull(elearningAttempt.deletedAt)))
          .orderBy(desc(elearningAttempt.createdAt)),
      );
      return c.json({ items: items.map(attemptView) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/elearning/courses/{id}/attempts",
      tags: ["workforce"],
      summary: "Start or resume my attempt",
      description:
        "workforce.self.read. Resumes the member's attempt in progress, or starts one, and gives a launch token for the content origin (signed, for this attempt only, expiring). Audited when an attempt starts.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ElearningLaunch, "Ready to launch"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const { id } = c.req.valid("param");
      const { config } = c.get("services");
      const { course, attempt, resumed } = await change(
        c,
        access,
        A.started,
        ATTEMPT_SOURCE,
        null,
        async (tx) => {
          const [found] = await tx
            .select()
            .from(elearningCourse)
            .where(and(eq(elearningCourse.id, id), eq(elearningCourse.status, "active")));
          if (!found) throw refused(problems.notFound(), A.started, COURSE_SOURCE, id, "not_found");
          const [open] = await tx
            .select()
            .from(elearningAttempt)
            .where(
              and(
                eq(elearningAttempt.courseId, id),
                eq(elearningAttempt.workerId, access.tenantUserId),
                eq(elearningAttempt.status, "in_progress"),
              ),
            )
            .orderBy(desc(elearningAttempt.createdAt))
            .limit(1);
          if (open) return { course: found, attempt: open, resumed: true };
          const [row] = await tx
            .insert(elearningAttempt)
            .values({ courseId: id, workerId: access.tenantUserId })
            .returning();
          if (!row) throw new Error("attempt not stored");
          await audit(c, tx, access, {
            action: A.started,
            resourceType: ATTEMPT_SOURCE,
            resourceId: row.id,
            scopeExtra: { courseId: id },
          });
          return { course: found, attempt: row, resumed: false };
        },
      );
      const token = signLaunchToken(
        {
          attemptId: attempt.id,
          tenantId: access.tenantId,
          workerId: access.tenantUserId,
          courseId: course.id,
          expiresAt: Math.floor(Date.now() / 1000) + config.ELEARNING_LAUNCH_MINUTES * 60,
        },
        config.ELEARNING_LAUNCH_SECRET,
      );
      return c.json(
        {
          attemptId: attempt.id,
          courseId: course.id,
          title: course.title,
          standard: course.standard as "scorm_1_2" | "scorm_2004" | "xapi",
          status: attempt.status as "in_progress",
          token,
          launchPath: course.launchPath,
          launchQuery: course.launchQuery,
          location: attempt.location,
          suspendData: attempt.suspendData,
          entry:
            resumed && (attempt.location || attempt.suspendData)
              ? ("resume" as const)
              : ("ab-initio" as const),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/workforce/elearning/attempts/{id}",
      tags: ["workforce"],
      summary: "Save what the runtime reported",
      description:
        "workforce.self.read, the member's own attempt. The SCORM data model elements the runtime committed (allowlisted, bounded); the attempt's status only moves forward, and a completion or pass becomes a training record once. Not for xAPI courses (their statements settle them).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ElearningCommit } } },
      },
      responses: {
        200: jsonBody(ElearningAttempt, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const saved = await change(
        c,
        access,
        "workforce.elearning_attempt.saved",
        ATTEMPT_SOURCE,
        id,
        async (tx) => {
          const [attempt] = await tx
            .select()
            .from(elearningAttempt)
            .where(
              and(eq(elearningAttempt.id, id), eq(elearningAttempt.workerId, access.tenantUserId)),
            );
          if (!attempt) throw problems.notFound();
          const [course] = await tx
            .select()
            .from(elearningCourse)
            .where(eq(elearningCourse.id, attempt.courseId));
          if (!course || course.standard === "xapi") {
            throw problems.invalid("This course reports through its statements.");
          }
          const standard = course.standard as "scorm_1_2" | "scorm_2004";
          const problem = cmiProblem(standard, body.cmi);
          if (problem) {
            throw new HttpProblem(
              422,
              "cmi_refused",
              "The course sent something Harbour does not keep.",
            );
          }
          const outcome = attemptOutcome(standard, body.cmi);
          const status = nextAttemptStatus(attempt.status as never, outcome.status);
          const location = body.cmi["cmi.core.lesson_location"] ?? body.cmi["cmi.location"];
          const suspend = body.cmi["cmi.suspend_data"];
          const seconds = body.finished
            ? (sessionSeconds(body.cmi["cmi.core.session_time"] ?? body.cmi["cmi.session_time"]) ??
              0)
            : 0;
          const [row] = await tx
            .update(elearningAttempt)
            .set({
              status,
              ...(outcome.score !== null ? { score: String(outcome.score) } : {}),
              ...(location !== undefined ? { location } : {}),
              ...(suspend !== undefined ? { suspendData: suspend } : {}),
              totalSeconds: Math.min(attempt.totalSeconds + seconds, 2_000_000_000),
              ...(body.finished ? { finishedAt: new Date() } : {}),
            })
            .where(eq(elearningAttempt.id, id))
            .returning();
          if (!row) throw problems.conflict();
          return row;
        },
      );
      const after = await afterSettled(c, access.tenantId, saved, access);
      return c.json(attemptView(after), 200);
    },
  );

// ------------------------------------------------------------------------------------------------
// The token routes: no session; the content origin presents the attempt's launch token
// ------------------------------------------------------------------------------------------------

const tokenProblem = () =>
  new HttpProblem(404, "launch_not_found", "This course link has ended. Open the course again.");

function claimsOf(c: Context<AppEnv>, token: string): LaunchClaims {
  const claims = verifyLaunchToken(token, c.get("services").config.ELEARNING_LAUNCH_SECRET);
  if (!claims) throw tokenProblem();
  return claims;
}

/** The attempt and course the token names, as its member sees them (their own, staff role held). */
async function launchedAttempt(c: Context<AppEnv>, claims: LaunchClaims) {
  const found = await asLauncher(c.get("services").db, claims, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(elearningAttempt)
      .where(
        and(
          eq(elearningAttempt.id, claims.attemptId),
          eq(elearningAttempt.workerId, claims.workerId),
          eq(elearningAttempt.courseId, claims.courseId),
        ),
      );
    if (!attempt) return null;
    const [course] = await tx
      .select()
      .from(elearningCourse)
      .where(eq(elearningCourse.id, claims.courseId));
    return course ? { attempt, course } : null;
  });
  if (!found) throw tokenProblem();
  return found;
}

const XapiStatement = z
  .object({
    id: z.uuid().optional(),
    verb: z.object({ id: z.url().max(300) }).passthrough(),
    result: z
      .object({ score: z.object({ scaled: z.number().optional() }).passthrough().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const elearningLaunchRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/e/launch/{token}/files/{path}",
      tags: ["workforce"],
      summary: "A file of a launched course (content origin only)",
      description:
        "No session: the launch token names one attempt. `path` is the file's path inside the package, URL-encoded as one segment. Only the package's own files of allowlisted types are served, never a folder; the web tier serves them only on the content origin, with its own Content-Security-Policy.",
      request: { params: FileParam },
      responses: {
        200: {
          description: "The file",
          content: { "application/octet-stream": { schema: binary } },
        },
        404: { description: "No such file, or the link has ended" },
      },
    }),
    async (c) => {
      const { token, path } = c.req.valid("param");
      const claims = claimsOf(c, token);
      const type = contentTypeOf(path);
      if (entryNameProblem(path) || path.endsWith("/") || !type) throw problems.notFound();
      const { course } = await launchedAttempt(c, claims);
      const { db, storage } = c.get("services");
      let bytes = packages.get(course.packageSha256);
      if (!bytes) {
        const where = await packageLocation(db, claims.tenantId, course.documentId);
        if (where?.status !== "available" || where.sha256 !== course.packageSha256) {
          throw problems.notFound();
        }
        const stored = await storage.get(where.storageKey);
        if (!stored) throw problems.notFound();
        bytes = Buffer.from(stored);
        packages.set(course.packageSha256, bytes);
      }
      const file = packageFile(bytes, path);
      if (!file) throw problems.notFound();
      return c.body(new Uint8Array(file), 200, {
        "content-type": type,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=300",
        "cross-origin-resource-policy": "same-site",
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/e/launch/{token}/statements",
      tags: ["workforce"],
      summary: "Keep a launched course's xAPI statements (content origin only)",
      description:
        "No session: the launch token names one attempt. One statement or up to 50, each at most 16 KB, kept as sent (once per statement id); a completed, passed or failed verb settles an xAPI course's attempt, and a completion or pass becomes a training record once. Returns the statement ids, as an xAPI learning record store does.",
      request: {
        params: TokenParam,
        body: { content: { "application/json": { schema: z.unknown() } } },
      },
      responses: {
        200: jsonBody(z.array(z.uuid()), "Kept"),
        400: { description: "Not statements Harbour can keep" },
        404: { description: "The link has ended" },
      },
    }),
    async (c) => {
      const { token } = c.req.valid("param");
      const claims = claimsOf(c, token);
      const raw = c.req.valid("json");
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.length === 0 || list.length > 50) {
        throw new HttpProblem(400, "statements_refused", "Send between 1 and 50 statements.");
      }
      const parsed = list.map((s) => {
        const ok = XapiStatement.safeParse(s);
        if (!ok.success || Buffer.byteLength(JSON.stringify(s)) > XAPI_STATEMENT_MAX_BYTES) {
          throw new HttpProblem(
            400,
            "statements_refused",
            "A statement is not one Harbour can keep.",
          );
        }
        return { ...ok.data, id: ok.data.id ?? crypto.randomUUID() };
      });
      const { attempt, course } = await launchedAttempt(c, claims);
      const settled = await asLauncher(c.get("services").db, claims, async (tx) => {
        for (const s of parsed) {
          await tx
            .insert(elearningStatement)
            .values({ attemptId: attempt.id, statementId: s.id, verb: s.verb.id, statement: s })
            .onConflictDoNothing();
        }
        if (course.standard !== "xapi") return null;
        let status = attempt.status as "in_progress" | "completed" | "passed" | "failed";
        let score: number | null = null;
        for (const s of parsed) {
          const outcome = xapiOutcome(s.verb.id, s.result?.score?.scaled);
          if (!outcome) continue;
          status = nextAttemptStatus(status, outcome.status);
          if (outcome.score !== null) score = outcome.score;
        }
        if (status === attempt.status && score === null) return null;
        const [row] = await tx
          .update(elearningAttempt)
          .set({
            status,
            ...(score !== null ? { score: String(score) } : {}),
            ...(status !== "in_progress" ? { finishedAt: new Date() } : {}),
          })
          .where(eq(elearningAttempt.id, attempt.id))
          .returning();
        return row ?? null;
      });
      if (settled) await afterSettled(c, claims.tenantId, settled, null);
      return c.json(
        parsed.map((s) => s.id),
        200,
      );
    },
  );
