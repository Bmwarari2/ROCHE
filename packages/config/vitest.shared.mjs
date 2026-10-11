// Shared Vitest defaults. Domain packages enforce 90% line coverage (master prompt section 7).
export const domainCoverage = {
  provider: "v8",
  reporter: ["text", "json-summary", "lcov"],
  thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
};

export const sharedTest = {
  environment: "node",
  include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  passWithNoTests: false,
};
