import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

const desktopRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(desktopRoot, "..");
const packaged = process.argv.includes("--packaged");
const testRoot = await mkdtemp(path.join(tmpdir(), "rudder-app-builder-smoke-"));
const projectRoot = path.join(testRoot, "project");
const registryPath = path.join(testRoot, "desktop", "local-apps.json");
const appStateRoot = path.join(testRoot, "desktop", "app-builder");
const runnerPath = packaged
  ? path.join(desktopRoot, ".packaged", "app", "dist", "app-builder-runner.mjs")
  : path.join(desktopRoot, "src", "app-builder-runner.mjs");
const controllerModuleRoot = packaged
  ? path.join(desktopRoot, ".packaged", "app", "dist")
  : path.join(desktopRoot, "dist");
const templateRoot = packaged
  ? path.join(
      desktopRoot,
      ".packaged",
      "server-package",
      "resources",
      "bundled-skills",
      "app-builder",
      "assets",
      "scaffold",
    )
  : path.join(
      repositoryRoot,
      "server",
      "resources",
      "bundled-skills",
      "app-builder",
      "assets",
      "scaffold",
    );

await Promise.all([access(runnerPath), access(templateRoot), mkdir(projectRoot)]);
if (packaged) {
  assert.match(
    await readFile(path.join(templateRoot, ".npmrc"), "utf8"),
    /auto-install-peers=false/,
  );
}

const [
  { AppBuilderController },
  { AppBuilderDataManager },
  { AppBuilderPreviewController },
  { LocalAppsController },
  { LocalAppRegistry },
  { LocalAppRuntimeManager },
] = await Promise.all([
  import(pathToFileURL(path.join(controllerModuleRoot, "app-builder-ipc.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "app-builder-data.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "app-builder-preview.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "local-apps-controller.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "local-apps-registry.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "local-apps-runtime.js")).href),
]);

const registry = new LocalAppRegistry({
  registryPath,
  installationId: "app-builder-smoke-desktop",
});
const runtime = new LocalAppRuntimeManager({ registry });
const localApps = new LocalAppsController({
  registry,
  runtime,
  selectFolder: async () => null,
  confirmDefinition: async () => true,
});
const preview = new AppBuilderPreviewController({
  registry,
  localApps,
  runnerExecutable: process.execPath,
  buildRunnerArgv: ({ appRoot }) => [runnerPath, appRoot, "preview"],
});
const data = new AppBuilderDataManager(appStateRoot);
const appBuilder = new AppBuilderController({
  templateRoot,
  resolveProjectRoot: async () => projectRoot,
  preview,
  data,
  selectExportDirectory: async () => null,
  selectImportPackage: async () => null,
});

let binding;
let browser;
try {
  const scaffold = await appBuilder.scaffold(
    "project-smoke",
    "apps/smoke-crm",
    "smoke-crm",
    "Smoke CRM",
  );
  assert.equal(scaffold.manifest.app.slug, "smoke-crm");
  binding = await appBuilder.ensurePreview(
    "project-smoke",
    "apps/smoke-crm",
    null,
    true,
  );
  const started = await appBuilder.startPreview(
    "project-smoke",
    "apps/smoke-crm",
    binding,
  );
  assert.equal(started.runtime.status, "running");
  assert.match(started.target.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const health = await fetch(new URL("/api/__rudder/health", started.target.origin));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const uniqueEmail = `smoke-${Date.now()}@example.test`;
  const created = await fetch(new URL("/api/contacts", started.target.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Packaged browser smoke",
      email: uniqueEmail,
      company: "Rudder",
    }),
  });
  assert.equal(created.status, 201, await created.text());

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(new URL(started.target.openPath, started.target.origin).toString());
  await page.getByText(uniqueEmail).waitFor();

  await appBuilder.stopPreview("project-smoke", "apps/smoke-crm", binding);
  const restarted = await appBuilder.startPreview(
    "project-smoke",
    "apps/smoke-crm",
    binding,
  );
  const contacts = await fetch(new URL("/api/contacts", restarted.target.origin));
  assert.equal(contacts.status, 200);
  assert.match(await contacts.text(), new RegExp(uniqueEmail.replace(".", "\\.")));

  const productionRoot = path.join(
    projectRoot,
    "apps",
    "smoke-crm",
    "data",
    "production",
  );
  await mkdir(productionRoot, { recursive: true });
  const productionSentinel = path.join(productionRoot, "do-not-touch.txt");
  await writeFile(productionSentinel, "production-sentinel");
  const snapshot = await appBuilder.snapshot(
    "project-smoke",
    "apps/smoke-crm",
    binding,
  );
  assert.ok(snapshot.manifest.files.some((file) => file.path === "dev.sqlite"));
  assert.ok(snapshot.manifest.files.every((file) => !file.path.includes("production")));
  assert.equal(await readFile(productionSentinel, "utf8"), "production-sentinel");

  assert.equal((await appBuilder.previewStatus(
    "project-smoke",
    "apps/smoke-crm",
    binding,
  )).status, "stopped");
  await localApps.shutdown();
  console.log(
    `[app-builder-smoke] PASS (${packaged ? "packaged assets" : "development assets"})`,
  );
} catch (error) {
  if (binding) {
    console.error((await localApps.logs(binding.definitionId).catch(() => [])).join("\n"));
  }
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (binding) {
    await appBuilder.stopPreview(
      "project-smoke",
      "apps/smoke-crm",
      binding,
    ).catch(() => undefined);
  }
  await localApps.shutdown().catch(() => undefined);
  await rm(testRoot, { recursive: true, force: true });
}
