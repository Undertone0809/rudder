import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Uses the installed application and its ordinary HTTP surface. The fixture
// owns only disposable data; no direct database query supplies the read result.
export async function runRustMemberDirectoryScenario(mode, helpers) {
  assert.equal(mode, "packaged", "default Rust read acceptance requires the installed package");
  for (const name of [
    "RUDDER_RUST_MEMBER_DIRECTORY_MODE",
    "RUDDER_SERVER_FOUNDATION_PATH",
    "RUDDER_NATIVE_ACTOR_ENVELOPE_KEY",
  ]) {
    assert.equal(process.env[name], undefined, `unset ${name} to exercise installed defaults`);
  }
  const {
    tmpRoot, allocateSmokePorts, preparePackagedExternalRuntimeFixture,
    launchDesktop, launchDesktopWindow, closeDesktop, createCompany,
    createCeo, createAgentApiKey, resolveInstancePaths, resolveServerLogPath,
    waitForSmokeCondition,
  } = helpers;
  const root = path.join(tmpRoot, "rust-member-directory");
  const ports = await allocateSmokePorts();
  const fixture = await preparePackagedExternalRuntimeFixture(root, { authBypass: true });
  const launchEnv = { ...fixture.env, RUDDER_DESKTOP_SMOKE_AUTH_BYPASS: "1" };
  const manifestPath = process.env.RUDDER_DESKTOP_SMOKE_BUILD_MANIFEST;
  assert.ok(manifestPath, "set RUDDER_DESKTOP_SMOKE_BUILD_MANIFEST to the exact candidate build receipt");
  const expectedBuild = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.match(expectedBuild.sourceSha, /^[a-f0-9]{40}$/u);
  const resources = path.dirname(path.dirname(fixture.cliEntry));
  const serverManifest = JSON.parse(await readFile(path.join(resources, "server-package", "package.json"), "utf8"));
  const nativeTarget = helpers.resolveNativeTarget(process.platform, process.arch);
  assert.ok(nativeTarget);
  const artifactPaths = {
    executable: fixture.executablePath,
    desktop: path.join(resources, "app", "dist", "main.js"),
    server: path.resolve(resources, "server-package", serverManifest.main ?? "dist/index.js"),
    foundation: path.join(resources, "native", nativeTarget, process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation"),
  };
  const artifactHashes = {};
  for (const [name, artifactPath] of Object.entries(artifactPaths)) {
    artifactHashes[name] = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
    assert.equal(artifactHashes[name], expectedBuild.artifactSha256?.[name], `${name} must match the frozen candidate build`);
  }
  const paths = resolveInstancePaths(root);
  let run;
  try {
    run = await launchDesktop(root, mode, ports, launchEnv);
    const org = await createCompany(run.baseUrl, "RMD");
    const foreignOrg = await createCompany(run.baseUrl, "RMF");
    const agent = await createCeo(run.baseUrl, org.id);
    const secondAgent = await createCeo(run.baseUrl, org.id);
    const agentIds = new Set([agent.id, secondAgent.id]);
    const key = await createAgentApiKey(run.baseUrl, agent.id);
    assert.equal(typeof key.token, "string");
    const headers = { Authorization: `Bearer ${key.token}` };
    const directoryPath = `/api/orgs/${org.id}/members/directory?type=agent&fullIds=true&limit=1`;
    const readDirectory = async () => {
      const response = await fetch(`${run.baseUrl}${directoryPath}`, { headers, signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json();
      assert.equal(body.items.length, 1);
      assert.ok(agentIds.has(body.items[0].ref));
      assert.equal(body.items[0].name, agent.name);
      assert.equal(body.total, 2);
      assert.equal(body.hasMore, true);
      assert.equal(typeof body.nextCursor, "string");
      return body;
    };
    const initial = await readDirectory();
    const nextResponse = await fetch(`${run.baseUrl}${directoryPath}&cursor=${encodeURIComponent(initial.nextCursor)}`, { headers });
    assert.equal(nextResponse.status, 200);
    const nextPage = await nextResponse.json();
    assert.equal(nextPage.total, 2);
    assert.equal(nextPage.items.length, 1);
    assert.notEqual(nextPage.items[0].ref, initial.items[0].ref);
    assert.deepEqual(new Set([initial.items[0].ref, nextPage.items[0].ref]), agentIds);
    assert.equal(nextPage.hasMore, false);
    assert.equal(nextPage.nextCursor, null);
    const foreign = await fetch(`${run.baseUrl}/api/orgs/${foreignOrg.id}/members/directory`, { headers });
    assert.equal(foreign.status, 403, "a valid agent cannot read a foreign organization");
    const invalidLimit = await fetch(`${run.baseUrl}/api/orgs/${org.id}/members/directory?limit=0`, { headers });
    assert.equal(invalidLimit.status, 400);
    assert.deepEqual(await invalidLimit.json(), { error: "'limit' must be between 1 and 100" });

    const readReceipts = async () => {
      const content = await readFile(await resolveServerLogPath(paths.logsDir), "utf8");
      return content.split("\n")
        .filter((line) => line.includes("Rust member directory bridge receipt"))
        .flatMap((line) => {
          // File logging uses pino-pretty singleLine: the structured fields
          // follow the timestamp/level/message prefix.
          const fieldsStart = line.indexOf("{");
          try { return fieldsStart < 0 ? [] : [JSON.parse(line.slice(fieldsStart))]; } catch { return []; }
        }).filter((entry) => entry.orgId === org.id);
    };
    const isRustRead = (entry) => entry.status === 200
      && entry.probe_mode === "required" && entry.response_authority === "rust"
      && entry.rust_invoked === true && entry.old_authority_invoked === false;
    await waitForSmokeCondition("default installed Rust read receipt", async () => {
      const receipts = await readReceipts();
      return receipts.find(isRustRead);
    });

    let childRecovery = { status: "not_exercised", reason: "POSIX process enumeration unavailable on this platform" };
    if (process.platform !== "win32") {
      const descriptor = JSON.parse(await readFile(paths.runtimeDescriptorPath, "utf8"));
      const findFoundationChildren = async () => {
        const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="]);
        return stdout.split("\n").flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
          return match && Number(match[2]) === descriptor.pid && match[3] === artifactPaths.foundation
            ? [Number(match[1])] : [];
        });
      };
      const children = await findFoundationChildren();
      assert.equal(children.length, 1, "exactly one fixture-owned foundation child must serve the read");
      const oldChild = children[0];
      process.kill(oldChild, "SIGKILL");
      await waitForSmokeCondition("fixture foundation child exit", async () => !(await findFoundationChildren()).includes(oldChild));
      const recovered = await waitForSmokeCondition("default read after foundation child interruption", readDirectory);
      assert.deepEqual(recovered, initial);
      const replacementChildren = await findFoundationChildren();
      assert.equal(replacementChildren.length, 1);
      assert.notEqual(replacementChildren[0], oldChild);
      assert.equal(JSON.parse(await readFile(paths.runtimeDescriptorPath, "utf8")).pid, descriptor.pid,
        "child recovery must preserve the installed server owner");
      childRecovery = { status: "passed", oldChild, replacementChild: replacementChildren[0], serverPid: descriptor.pid };
    }
    await closeDesktop(run.electronApp);
    run = null;
    const beforeRestartCount = (await readReceipts()).filter(isRustRead).length;
    run = await launchDesktop(root, mode, ports, launchEnv);
    assert.deepEqual(await readDirectory(), initial, "installed restart preserves directory data and authorization");
    const receipts = await waitForSmokeCondition("restarted installed Rust read receipt", async () => {
      const entries = await readReceipts();
      return entries.filter(isRustRead).length > beforeRestartCount ? entries : null;
    });
    assert.ok(receipts.every((entry) => entry.old_authority_invoked === false), "default requests must never invoke the Node reader");
    console.log("[desktop-smoke] installed Rust member directory evidence", JSON.stringify({
      orgId: org.id, foreignOrgId: foreignOrg.id, agentId: agent.id,
      apiPort: ports.appPort, databasePort: ports.dbPort, receipts: receipts.length,
      sourceSha: expectedBuild.sourceSha, artifactHashes,
      childRecovery,
      runtimeDescriptor: JSON.parse(await readFile(paths.runtimeDescriptorPath, "utf8")),
    }));
    await closeDesktop(run.electronApp);
    run = null;

    // An explicitly unavailable asset must not silently restore the Node read
    // path. This changes only this disposable launch, never packaged files.
    run = await launchDesktopWindow(root, mode, ports, {
      ...launchEnv,
      RUDDER_SERVER_FOUNDATION_PATH: path.join(root, "missing-foundation"),
    });
    await run.page.waitForFunction(() => document.body.dataset.bootView === "failed", null, { timeout: 60_000 });
    const failure = await run.page.evaluate(() => window.rudderBoot.getState());
    const failureLog = await readFile(await resolveServerLogPath(paths.logsDir), "utf8");
    // Startup errors before the server logger is ready are emitted by the
    // Desktop process; the recovery view intentionally shows sanitized copy.
    assert.match(`${JSON.stringify(failure)}\n${failureLog}\n${run.getStartupOutput()}`, /rudder-server-foundation binary is unavailable/u,
      "boot must fail specifically because the configured foundation asset is missing");
    const response = await fetch(`http://127.0.0.1:${ports.appPort}${directoryPath}`, { headers }).catch(() => null);
    assert.ok(!response || response.status >= 500, "missing Rust asset cannot serve a successful Node read");
    console.log("RUST_MEMBER_DIRECTORY_INSTALLED_DEFAULT_PASS");
  } finally {
    if (run) await closeDesktop(run.electronApp);
  }
}
