import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const smokeDir = path.dirname(fileURLToPath(import.meta.url));
const smokeScriptPath = path.join(smokeDir, "openclaw-gateway-e2e.sh");

test("OpenClaw smoke bootstrap installs only the canonical Rudder Docs skill", async () => {
  const script = await fs.readFile(smokeScriptPath, "utf8");

  assert.match(script, /local skill_dir="\$\{OPENCLAW_CONFIG_DIR%\/\}\/skills\/rudder-docs"/);
  assert.match(script, /api_request "GET" "\/skills\/rudder-docs"/);
  assert.doesNotMatch(script, /skills\/rudder"/);
  assert.doesNotMatch(script, /api_request "GET" "\/skills\/rudder"/);
});
