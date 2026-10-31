/**
 * What the API logs about an unexpected error (section 5.3: logs carry opaque ids only). An error's
 * message can carry data: a database error from Drizzle repeats the query and its parameters, which
 * may be a person's name, date of birth or NHS number. So the log keeps the error's name, the
 * database's error code from its cause, and the stack without its first line (the line that repeats
 * the message); never the message itself.
 */
export function loggableError(error: unknown): {
  readonly name: string;
  readonly code: string | null;
  readonly stack: string | null;
} {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    stack?: unknown;
    code?: unknown;
    cause?: { code?: unknown } | null;
  };
  const name = typeof e.name === "string" ? e.name : "Error";
  const causeCode = e.cause && typeof e.cause.code === "string" ? e.cause.code : null;
  const ownCode = typeof e.code === "string" ? e.code : null;
  // Only the frames: every line from the first "    at " on.
  const stack =
    typeof e.stack === "string"
      ? e.stack
          .split("\n")
          .filter((line) => /^\s+at /.test(line))
          .join("\n") || null
      : null;
  return { name, code: causeCode ?? ownCode, stack };
}
