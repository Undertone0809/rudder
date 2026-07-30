import { defineConfig } from "drizzle-kit";
import path from "node:path";

const dataDir = process.env.RUDDER_APP_DATA_DIR
  ? path.resolve(process.env.RUDDER_APP_DATA_DIR)
  : path.resolve("data");
const mode = process.env.RUDDER_APP_DATA_MODE === "production"
  ? "app.sqlite"
  : "dev.sqlite";

export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: path.join(dataDir, mode),
  },
});
