import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

const desktopRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(desktopRoot, "..");
const packaged = process.argv.includes("--packaged");
const legacyRevisionOne = process.argv.includes("--legacy-revision-1");
const testRoot = await mkdtemp(path.join(tmpdir(), "rudder-app-builder-smoke-"));
const projectRoot = path.join(
  testRoot,
  "organization-workspaces",
  "windows-long-path-contract",
  "nested-operator-project",
  "production-shaped-workspace-depth",
  "project",
);
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

async function sourceManifest(root) {
  const manifest = new Map();
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.posix.join(prefix, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        manifest.set(
          relativePath,
          createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
        );
      }
    }
  }
  await visit(root);
  return manifest;
}

async function assertSourceManifest(root, manifest) {
  for (const [relativePath, expectedHash] of manifest) {
    const currentHash = createHash("sha256")
      .update(await readFile(path.join(root, ...relativePath.split("/"))))
      .digest("hex");
    assert.equal(
      currentHash,
      expectedHash,
      `Managed legacy preview modified App source: ${relativePath}`,
    );
  }
}

await Promise.all([
  access(runnerPath),
  access(templateRoot),
  mkdir(projectRoot, { recursive: true }),
]);
if (process.platform === "win32") {
  const legacyNativeBinaryPath = path.join(
    projectRoot,
    "apps",
    "smoke-crm",
    "node_modules",
    ".pnpm",
    "@esbuild+win32-x64@0.25.12",
    "node_modules",
    "@esbuild",
    "win32-x64",
    "esbuild.exe",
  );
  assert.ok(
    legacyNativeBinaryPath.length > 260,
    "Windows App Builder smoke must retain a production-shaped long workspace path",
  );
}
if (packaged) {
  assert.match(
    await readFile(path.join(templateRoot, ".npmrc"), "utf8"),
    /auto-install-peers=false/,
  );
}

const [
  { AppBuilderController },
  { AppBuilderDataManager },
  {
    APP_BUILDER_INHERITED_ENV_NAMES,
    createAppBuilderInstallPlan,
    WINDOWS_APP_BUILDER_EXECUTABLE_PATH_LIMIT,
  },
  { AppBuilderPreviewController },
  { LocalAppsController },
  { LocalAppRegistry },
  { LocalAppRuntimeManager },
] = await Promise.all([
  import(pathToFileURL(path.join(controllerModuleRoot, "app-builder-ipc.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "app-builder-data.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "app-builder-package-store.mjs")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "app-builder-preview.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "local-apps-controller.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "local-apps-registry.js")).href),
  import(pathToFileURL(path.join(controllerModuleRoot, "local-apps-runtime.js")).href),
]);

const registry = new LocalAppRegistry({
  registryPath,
  installationId: "app-builder-smoke-desktop",
});
const runtime = new LocalAppRuntimeManager({
  registry,
  maxLogBytes: 2 * 1024 * 1024,
  ...(process.platform === "win32" ? { cleanupTimeoutMs: 30_000 } : {}),
});
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
  inheritedEnvNames: APP_BUILDER_INHERITED_ENV_NAMES,
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
  const appRoot = path.join(projectRoot, "apps", "smoke-crm");
  let legacySourceManifest;
  if (legacyRevisionOne) {
    await writeFile(path.join(appRoot, "next.config.ts"), [
      'import type { NextConfig } from "next";',
      "",
      "const nextConfig: NextConfig = {",
      "  devIndicators: false,",
      '  output: "standalone",',
      "  poweredByHeader: false,",
      "  turbopack: {",
      "    root: process.cwd(),",
      "  },",
      "};",
      "",
      "export default nextConfig;",
      "",
    ].join("\n"));
    legacySourceManifest = await sourceManifest(appRoot);
  }
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

  if (process.platform === "win32") {
    const installPlan = createAppBuilderInstallPlan({
      appRoot,
      environment: process.env,
      platform: process.platform,
      temporaryDirectory: tmpdir(),
    });
    const nativePackageDirectories = (await readdir(installPlan.virtualStoreDir, {
      withFileTypes: true,
    })).filter((entry) => (
      entry.isDirectory()
      && /^@esbuild\+win32-(?:arm64|ia32|x64)@/.test(entry.name)
    ));
    assert.ok(
      nativePackageDirectories.length > 0,
      "Windows App Builder smoke must install at least one native esbuild package",
    );
    for (const entry of nativePackageDirectories) {
      const architecture = entry.name.match(/^@esbuild\+win32-([^@]+)@/)?.[1];
      assert.ok(architecture, `Could not parse native package directory ${entry.name}`);
      const executablePath = path.join(
        installPlan.virtualStoreDir,
        entry.name,
        "node_modules",
        "@esbuild",
        `win32-${architecture}`,
        "esbuild.exe",
      );
      await access(executablePath);
      assert.ok(
        executablePath.length <= WINDOWS_APP_BUILDER_EXECUTABLE_PATH_LIMIT,
        `Windows native executable exceeds the App Builder path budget: ${executablePath}`,
      );
      assert.ok(
        !executablePath.toLowerCase().startsWith(appRoot.toLowerCase()),
        "Windows native executables must be installed outside the App Builder workspace",
      );
    }
  }

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
  if (legacySourceManifest) {
    await assertSourceManifest(appRoot, legacySourceManifest);
  }
  console.log(
    `[app-builder-smoke] PASS (${packaged ? "packaged assets" : "development assets"}${legacyRevisionOne ? ", legacy revision-1" : ""})`,
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
