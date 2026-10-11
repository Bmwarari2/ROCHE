import pino from "pino";

/**
 * Structured logs carry opaque identifiers only, never personal data (section 5.3). Request bodies
 * are never logged; anything that might hold personal data is redacted as a second line of defence.
 */
export function createLogger(level: string) {
  return pino({
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
  });
}

export type Logger = ReturnType<typeof createLogger>;
