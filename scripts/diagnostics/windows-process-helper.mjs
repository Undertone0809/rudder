import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWindowsProcessController,
  terminateWindowsChildProcessHandle,
} from "../../desktop/src/local-app-windows-processes.mjs";

// Diagnostic-only: never change the controller's 60s startup/request budgets.
export const CASE_DEADLINE_MS = 185_000;
export const CAMPAIGN_DEADLINE_MS = 16 * 60_000;
const EXIT_DEADLINE_MS = 2_000;
const PARSE = "$request = ConvertFrom-Json -InputObject $line";
const READY = "[Console]::Out.WriteLine('{\"id\":0,\"ok\":true}')";
const ENV_KEYS = ["ELECTRON_RUN_AS_NODE", "SystemRoot", "WINDIR", "TEMP", "TMP"];
const META = `
[Console]::Error.WriteLine("RUDDER_DIAG|powershell_version|$($PSVersionTable.PSVersion)")
$rudderFileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
[Console]::Error.WriteLine("RUDDER_DIAG|powershell_file_version|$($rudderFileVersion.FileMajorPart).$($rudderFileVersion.FileMinorPart).$($rudderFileVersion.FileBuildPart).$($rudderFileVersion.FilePrivatePart)")
[Console]::Error.WriteLine("RUDDER_DIAG|clr_version|$([Environment]::Version)")
[Console]::Error.WriteLine("RUDDER_DIAG|stopwatch_frequency|$([Diagnostics.Stopwatch]::Frequency)")
[Console]::Error.WriteLine("RUDDER_DIAG|input_redirected|$([Console]::IsInputRedirected)")
foreach ($name in @('PSModulePath', 'USERPROFILE', 'LOCALAPPDATA')) {
  $present = $null -ne [Environment]::GetEnvironmentVariable($name)
  [Console]::Error.WriteLine("RUDDER_DIAG|env_$name|$present")
}
[Console]::Error.Flush()
`;
const RESOLVE = `
Write-RudderHelperPhase 0 "diag_discovery_start"
$rudderJsonCommand = $ExecutionContext.InvokeCommand.GetCommand('ConvertFrom-Json', [Management.Automation.CommandTypes]::Cmdlet)
Write-RudderHelperPhase 0 "diag_discovery_done"
if ($null -eq $rudderJsonCommand) { throw 'Diagnostic converter unavailable' }
$rudderExpectedType = $rudderJsonCommand.ImplementingType.FullName -eq 'Microsoft.PowerShell.Commands.ConvertFromJsonCommand'
$rudderExpectedModule = $rudderJsonCommand.ModuleName -eq 'Microsoft.PowerShell.Utility'
[Console]::Error.WriteLine("RUDDER_DIAG|expected_converter_type|$rudderExpectedType")
[Console]::Error.WriteLine("RUDDER_DIAG|expected_converter_module|$rudderExpectedModule")
[Console]::Error.WriteLine("RUDDER_DIAG|converter_assembly_version|$($rudderJsonCommand.ImplementingType.Assembly.GetName().Version)")
[Console]::Error.Flush()
if (-not $rudderExpectedType -or -not $rudderExpectedModule) { throw 'Unexpected diagnostic converter identity' }
Write-RudderHelperPhase 0 "diag_conversion_start"
$request = & $rudderJsonCommand -InputObject $line
Write-RudderHelperPhase 0 "diag_conversion_done"
`;
const TRUSTED_INIT = `
Write-RudderHelperPhase 0 "diag_utility_import_start"
$rudderUtilityPath = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
Import-Module -Name $rudderUtilityPath -ErrorAction Stop
Write-RudderHelperPhase 0 "diag_utility_import_done"
Write-RudderHelperPhase 0 "diag_serializer_load_start"
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
Write-RudderHelperPhase 0 "diag_serializer_load_done"
Write-RudderHelperPhase 0 "diag_serializer_init_start"
$rudderSerializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
[void]$rudderSerializer.DeserializeObject('{}')
Write-RudderHelperPhase 0 "diag_serializer_init_done"
`;

export function minimalWatchdogEnvironment(source = process.env) {
  const systemRoot = source.SystemRoot ?? "C:\\Windows";
  const temp = source.TEMP ?? source.TMP ?? path.win32.join(systemRoot, "Temp");
  return {
    ELECTRON_RUN_AS_NODE: "1",
    SystemRoot: systemRoot,
    WINDIR: source.WINDIR ?? systemRoot,
    TEMP: temp,
    TMP: source.TMP ?? temp,
  };
}

export function runnerIdentity(source = process.env) {
  return {
    imageId: /^[a-zA-Z0-9_-]{1,64}$/.test(source.ImageOS ?? "") ? source.ImageOS : null,
    imageVersion: /^\d{1,8}(?:\.\d{1,8}){1,3}$/.test(source.ImageVersion ?? "") ? source.ImageVersion : null,
    os: ["Windows", "Linux", "macOS"].includes(source.RUNNER_OS) ? source.RUNNER_OS : null,
    arch: ["X86", "X64", "ARM", "ARM64"].includes(source.RUNNER_ARCH) ? source.RUNNER_ARCH : null,
  };
}

export function initialProbePlan() {
  return [
    { name: "baseline", instrumentation: "none", requests: 2 },
    { name: "resolution", instrumentation: "resolution", requests: 2 },
    { name: "trusted-initialization", instrumentation: "trusted", requests: 2 },
  ];
}

function replaceOnce(script, needle, replacement) {
  if (script.split(needle).length !== 2) throw new Error("Diagnostic helper source drift");
  return script.replace(needle, replacement);
}

export function instrumentHelper(script, mode) {
  if (mode === "none") return script;
  if (!["resolution", "trusted"].includes(mode)) throw new Error("Unknown diagnostic instrumentation");
  const resolved = replaceOnce(script, PARSE, RESOLVE);
  return replaceOnce(resolved, READY, `${META}${mode === "trusted" ? TRUSTED_INIT : ""}\n${READY}`);
}

// Never persist the controller error: it can contain raw PowerShell stderr.
export function failureKind(error) {
  const message = String(error?.message ?? "");
  if (message.startsWith("Windows process helper request timed out")) return "request_timeout";
  if (message === "Windows process helper did not start in time") return "startup_timeout";
  if (message.startsWith("Windows process helper exited")) return "helper_exited";
  if (message === "Diagnostic helper source drift") return "source_drift";
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "diagnostic_deadline";
  return "operation_failed";
}

export function parseMetadata(line) {
  const match = /^RUDDER_DIAG\|([a-zA-Z_]+)\|([a-zA-Z0-9.]+)$/.exec(line);
  if (!match) return null;
  const [, key, value] = match;
  if (["powershell_version", "powershell_file_version", "clr_version", "converter_assembly_version"].includes(key)
    && /^\d+(?:\.\d+){1,3}$/.test(value)) return [key, value];
  if (key === "stopwatch_frequency" && /^\d{1,15}$/.test(value)) return [key, value];
  if (["input_redirected", "env_PSModulePath", "env_USERPROFILE", "env_LOCALAPPDATA",
    "expected_converter_type", "expected_converter_module"].includes(key)
    && /^(True|False)$/.test(value)) return [key, value === "True"];
  return null;
}

async function withAbort(operation, signal) {
  if (signal.aborted) {
    // request() has already been called; own its eventual rejection on this race.
    void Promise.resolve(operation).catch(() => undefined);
    signal.throwIfAborted();
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function settleOwnedHelper(child, { graceful = false, timeoutMs = EXIT_DEADLINE_MS } = {}) {
  if (!child) return { status: "not_spawned" };
  if (child.exitCode !== null || child.signalCode !== null) return { status: "exited" };
  if (graceful) {
    const exited = await new Promise((resolve) => {
      const finish = (value) => { clearTimeout(timer); child.removeListener("exit", onExit); resolve(value); };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      try { child.stdin.end(); } catch { finish(false); }
    });
    if (exited) return { status: "exit_after_eof" };
  }
  try {
    const result = await terminateWindowsChildProcessHandle(child, { timeoutMs });
    return { status: result === "already-exited" ? "exited" : "exit_after_signal" };
  } catch { return { status: "unverified" }; }
}

export function stalledAtConversion(result) {
  const lastStart = result.events.findLastIndex((event) => event.phase === "request_parse_start");
  const afterParse = result.events.slice(lastStart + 1);
  const conversionFinishedOrFailed = (event) => ["request_json_parse_done", "diag_conversion_done",
    "request_failed", "request_id_bound", "request_parse_done", "request_read_wait"].includes(event.phase)
    || event.phase.startsWith("response_") || event.phase.startsWith("stdout_response_")
    || event.phase === "stdout_json_parse_invalid";
  return result.failure === "request_timeout"
    && lastStart !== -1
    && !afterParse.some(conversionFinishedOrFailed);
}

export function eofFollowupNeeded(result) {
  if (result.eofAtMs === undefined) return false;
  const completed = result.events.find((event) => event.phase === "request_json_parse_done"
    && event.elapsedMs >= result.eofAtMs);
  return Boolean(completed && completed.elapsedMs - result.eofAtMs <= 2_000);
}

export async function runProbe(probe, { signal, environment, spawnProcess = spawn,
  createController = createWindowsProcessController } = {}) {
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  const result = { name: probe.name, instrumentation: probe.instrumentation, events: [], metadata: {}, requests: [] };
  const localSignal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(CASE_DEADLINE_MS)]);
  let child;
  let eofTimer;
  let firstParseSeen = false;
  let stderrBuffer = "";
  let controller;
  try {
    localSignal.throwIfAborted();
    controller = createController({
      // Deliberately do not pass requestTimeoutMs: keep production deadlines.
      observePhase(event) {
        if (result.events.length < 512 && ["node", "powershell"].includes(event.source)
          && /^[a-z_]{1,64}$/.test(event.phase) && /^\d{1,30}$/.test(event.clock)
          && Number.isSafeInteger(event.id) && event.id >= 0) {
          result.events.push({ source: event.source, id: event.id, phase: event.phase,
            clock: event.clock, elapsedMs: elapsed() });
        }
        if (event.source !== "powershell") return;
        if (event.phase === "request_json_parse_done") clearTimeout(eofTimer);
        if (event.phase !== "request_parse_start" || firstParseSeen) return;
        firstParseSeen = true;
        if (probe.eofDelayMs !== undefined) {
          eofTimer = setTimeout(() => {
            result.eofAtMs = elapsed();
            try { child.stdin.end(); result.eofWrite = "submitted"; }
            catch { result.eofWrite = "failed"; }
          }, probe.eofDelayMs);
        }
      },
      spawnProcess(executable, args, options) {
        if (args.length !== 4 || args[0] !== "-NoProfile" || args[1] !== "-NonInteractive"
          || args[2] !== "-Command") throw new Error("Diagnostic helper source drift");
        const script = instrumentHelper(args[3], probe.instrumentation);
        result.helperScriptSha256 = createHash("sha256").update(script).digest("hex");
        child = spawnProcess(executable, [...args.slice(0, 3), script], {
          ...options, env: environment ?? minimalWatchdogEnvironment(),
        });
        child.stderr.on("data", (chunk) => {
          // Metadata has a strict field/value allowlist. Drop everything else.
          stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4_096);
          let newline;
          while ((newline = stderrBuffer.indexOf("\n")) !== -1) {
            const line = stderrBuffer.slice(0, newline).replace(/\r$/, "");
            stderrBuffer = stderrBuffer.slice(newline + 1);
            const metadata = parseMetadata(line);
            if (metadata) result.metadata[metadata[0]] = metadata[1];
          }
        });
        return child;
      },
    });
    for (let index = 0; index < probe.requests; index += 1) {
      const requestedAtMs = elapsed();
      // This is the only supported request/target. No snapshots or termination authority.
      const capture = await withAbort(controller.request("capture", { pid: process.pid }), localSignal);
      if (capture?.pid !== process.pid || typeof capture?.createdAt !== "string" || !/^\d+$/.test(capture.createdAt)) {
        throw new Error("Diagnostic capture identity mismatch");
      }
      result.requests.push({ ordinal: index + 1, elapsedMs: elapsed() - requestedAtMs, identityMatched: true });
    }
    result.outcome = "capture_completed";
  } catch (error) {
    result.failure = failureKind(error);
    result.outcome = "capture_failed";
  } finally {
    clearTimeout(eofTimer);
    result.cleanup = await settleOwnedHelper(child, { graceful: result.outcome === "capture_completed" });
    result.elapsedMs = elapsed();
  }
  return result;
}

export async function runCampaign({ run = runProbe, environment = minimalWatchdogEnvironment(),
  signal = AbortSignal.timeout(CAMPAIGN_DEADLINE_MS), onResult = async () => {} } = {}) {
  const results = [];
  const execute = async (probe) => {
    if (signal.aborted || results.some((result) => result.cleanup.status === "unverified")) return null;
    const result = await run(probe, { signal, environment });
    results.push(result);
    await onResult(results);
    return result;
  };
  for (const probe of initialProbePlan()) await execute(probe);
  if (results.some(stalledAtConversion)) {
    const firstEof = await execute({ name: "eof-15s", instrumentation: "none", requests: 1, eofDelayMs: 15_000 });
    if (firstEof && eofFollowupNeeded(firstEof)) {
      await execute({ name: "eof-30s", instrumentation: "none", requests: 1, eofDelayMs: 30_000 });
    }
  }
  return { results, deadlineReached: signal.aborted };
}

async function main() {
  const outputFlag = process.argv.indexOf("--output");
  const output = outputFlag < 0 ? "windows-process-helper-diagnostics.json" : process.argv[outputFlag + 1];
  if (!output) throw new Error("Missing output destination");
  const environment = minimalWatchdogEnvironment();
  const report = {
    schemaVersion: 1,
    qualification: false,
    diagnosis: "inconclusive_requires_review",
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    runner: runnerIdentity(),
    sourceSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null,
    environmentKeysPresent: Object.fromEntries(ENV_KEYS.map((key) => [key, Object.hasOwn(environment, key)])),
    caseDeadlineMs: CASE_DEADLINE_MS,
    campaignDeadlineMs: CAMPAIGN_DEADLINE_MS,
    limitations: [
      "Fresh helper processes share a runner; later probes may benefit from OS or module caches.",
      "Instrumentation and EOF alter diagnostic variants; baseline uses the unchanged helper script.",
      "EOF-correlated completion is suggestive, not a causal verdict or a release qualification.",
      "Capture targets only this harness; Local App start, stop, descendants and packaged behavior are not tested.",
    ],
    results: [],
  };
  const save = async () => {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  };
  if (process.platform !== "win32") {
    report.blocker = "windows_required";
    await save();
    process.exitCode = 1;
    return;
  }
  const campaign = await runCampaign({ environment, onResult: async (results) => { report.results = results; await save(); } });
  Object.assign(report, campaign);
  report.reproducedConversionStall = report.results.some(stalledAtConversion);
  await save();
  console.log(JSON.stringify({ qualification: false, diagnosis: report.diagnosis,
    probes: report.results.map(({ name, outcome, cleanup }) => ({ name, outcome, cleanup })),
    reproducedConversionStall: report.reproducedConversionStall, deadlineReached: report.deadlineReached }));
  if (report.deadlineReached || report.results.some((result) => result.failure || result.cleanup.status === "unverified")) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Windows helper diagnostic harness failed; no raw error emitted"); process.exitCode = 1; });
}
