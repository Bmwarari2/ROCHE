import { defineConfig } from "drizzle-kit";

// Migrations are generated from the schema and run as the owning role (harbour_owner).
// Custom SQL migrations (generate:custom) carry what Drizzle cannot express: the app schema
// functions, row-level security, grants and append-only triggers (see ADR-0002).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["public", "auth"],
  dbCredentials: {
    url:
      process.env.DATABASE_OWNER_URL ??
      "postgres://harbour_owner:harbour_owner_local@localhost:5432/harbour",
  },
  strict: true,
  verbose: true,
});
