import { defineConfig } from "drizzle-kit";

const url = process.env.IDENTITY_MIGRATION_DATABASE_URL;
if (!url) throw new Error("IDENTITY_MIGRATION_DATABASE_URL is required");

export default defineConfig({
  schema: "./dist/schema.js",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  schemaFilter: ["rudder_identity"],
});
