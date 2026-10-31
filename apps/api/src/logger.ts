import pino from "pino";

/**
 * Structured logs carry opaque identifiers only, never personal data (section 5.3). Request bodies
 * are never logged; anything that might hold personal data is redacted as a second line of defence.
 */
export function createLogger(level: string, destination?: pino.DestinationStream) {
  const options: pino.LoggerOptions = {
    level,
    base: { service: "harbour-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.email",
        "*.name",
        "*.givenName",
        "*.familyName",
        "*.nhsNumber",
        "*.justification",
        "*.token",
      ],
      censor: "[redacted]",
    },
  };
  // A destination is given only where the lines are read back (the log-capture tests).
  return destination ? pino(options, destination) : pino(options);
}

export type Logger = ReturnType<typeof createLogger>;

/**
 * Logs an idle database connection that failed (the pool replaces it). Only the pool name and the
 * Postgres error code are logged, never the message or any query (section 5.3).
 */
export function idleErrorLogger(logger: Logger, pool: string) {
  return (error: Error & { readonly code?: string }) =>
    logger.warn(
      { pool, code: error.code ?? null },
      "database connection lost; the pool will open a new one",
    );
}

/** A constructor's name or a database code: a short token, never free text. */
const TOKEN = /^[A-Za-z0-9_$.]{1,60}$/;

/** A stack frame as V8 writes it: "    at fn (file:line:column)" or "    at file:line:column". */
const FRAME = /^\s+at\s.+:\d+:\d+\)?$/;

export interface LoggableError {
  /** The error's kind (its `name`), kept under `type` because `name` keys are redacted. */
  readonly type: string;
  /** The database's SQLSTATE (or a system code) from the error or its cause, when there is one. */
  readonly code: string | null;
  /** Only the stack's frames: never the message, nor the lines of the stack that repeat it. */
  readonly frames: readonly string[];
}

/**
 * What may be logged about an unexpected error (section 5.3). An error's message can hold data:
 * a failed query's message (DrizzleQueryError) carries the SQL and its values, such as a person's
 * name and date of birth, and the stack begins by repeating the message, a line for each of its
 * lines. A value can itself look like a frame ("    at 12 Acacia Road..." typed into a note), so
 * the lines that repeat the message are dropped first, by count, and only lines shaped like a real
 * frame (ending in a line and column) are kept of the rest (#118 review round 2, L1).
 */
export function loggableError(error: unknown): LoggableError {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    readonly name?: unknown;
    readonly message?: unknown;
    readonly code?: unknown;
    readonly stack?: unknown;
    readonly cause?: { readonly code?: unknown } | null;
  };
  const token = (value: unknown) => (typeof value === "string" && TOKEN.test(value) ? value : null);
  return {
    type: token(e.name) ?? "Error",
    code: token(e.cause?.code) ?? token(e.code),
    frames:
      typeof e.stack === "string"
        ? e.stack
            .split("\n")
            .slice(typeof e.message === "string" ? e.message.split("\n").length : 1)
            .filter((line) => FRAME.test(line))
        : [],
  };
}
