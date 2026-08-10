import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "components.json",
  "app/globals.css",
  "components/ui/button.tsx",
  "components/ui/field.tsx",
  "components/ui/table.tsx",
  "components/ui/empty.tsx",
];

function fail(message) {
  console.error(`Rudder UI preset invalid: ${message}`);
  process.exit(1);
}

let preset;
try {
  preset = JSON.parse(await readFile(path.join(root, "rudder.ui.json"), "utf8"));
} catch {
  fail("rudder.ui.json is missing or invalid JSON");
}

if (preset?.schemaVersion !== 1 || preset?.preset !== "rudder") {
  fail("unsupported preset identity");
}
if (!Number.isInteger(preset?.revision) || preset.revision < 1) {
  fail("revision must be a positive integer");
}
if (preset?.sourceOwnership !== "app") {
  fail("generated Apps must own their component source");
}

for (const relativePath of requiredFiles) {
  try {
    await access(path.join(root, relativePath));
  } catch {
    fail(`required file is missing: ${relativePath}`);
  }
}

const css = await readFile(path.join(root, "app/globals.css"), "utf8");
for (const token of ["--background", "--foreground", "--primary", "--destructive", "--border", "--ring", "--radius"]) {
  if (!css.includes(`${token}:`)) fail(`semantic token is missing: ${token}`);
}
if (!css.includes("@theme inline")) fail("Tailwind semantic token mapping is missing");

console.log(`Rudder UI preset ${preset.revision}: ok`);
