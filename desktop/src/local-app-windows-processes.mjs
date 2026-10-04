import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { isSafeLocalAppProcessId } from "./local-app-process-identity.mjs";

const defaultExecFile = promisify(execFile);
const WINDOWS_HELPER_START_TIMEOUT_MS = 60_000;
const WINDOWS_HELPER_REQUEST_TIMEOUT_MS = 60_000;
const WINDOWS_HELPER_TRACE_LIMIT = 32;
const WINDOWS_HELPER_PHASE_MARKER_PATTERN = /^RUDDER_WINPROC\|(\d+)\|([a-z_]+)\|(\d+)$/;

const WINDOWS_HELPER_SCRIPT = `
$nativeType = [Diagnostics.Process].Assembly.GetType('Microsoft.Win32.NativeMethods')
$nativeFlags = [Reflection.BindingFlags]'Public,NonPublic,Static'
$getProcessTimes = $nativeType.GetMethod('GetProcessTimes', $nativeFlags)
$terminateProcess = $nativeType.GetMethod('TerminateProcess', $nativeFlags)
function Write-RudderHelperPhase($requestId, $phase) {
  [Console]::Error.WriteLine("RUDDER_WINPROC|$requestId|$phase|$([Diagnostics.Stopwatch]::GetTimestamp())")
  [Console]::Error.Flush()
}
function Get-RudderCreationTime {
  param($handle, $requestId)
  Write-RudderHelperPhase $requestId "get_times_start"
  $arguments = @($handle, [long]0, [long]0, [long]0, [long]0)
  if (-not $getProcessTimes.Invoke($null, $arguments)) { throw 'GetProcessTimes failed' }
  Write-RudderHelperPhase $requestId "get_times_done"
  return ([long]$arguments[1]).ToString()
}
[Console]::Out.WriteLine('{"id":0,"ok":true}')
[Console]::Out.Flush()
Write-RudderHelperPhase 0 "ready_flush_done"
while ($true) {
  Write-RudderHelperPhase 0 "request_read_wait"
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  Write-RudderHelperPhase 0 "request_line_read"
  $request = $null
  $requestId = 0
  try {
    Write-RudderHelperPhase 0 "request_parse_start"
    $request = ConvertFrom-Json -InputObject $line
    Write-RudderHelperPhase 0 "request_json_parse_done"
    $requestId = [int]$request.id
    Write-RudderHelperPhase $requestId "request_id_bound"
    Write-RudderHelperPhase $requestId "request_parse_done"
    if ($request.type -eq 'capture') {
      Write-RudderHelperPhase $requestId "get_process_start"
      $candidate = Get-Process -Id ([int]$request.pid) -ErrorAction Stop
      Write-RudderHelperPhase $requestId "get_process_done"
      $createdAt = Get-RudderCreationTime -handle $candidate.SafeHandle -requestId $requestId
      $result = @{ pid = [int]$request.pid; createdAt = $createdAt }
    } elseif ($request.type -eq 'snapshot') {
      Write-RudderHelperPhase $requestId "snapshot_query_start"
      $all = @(Get-WmiObject -Class Win32_Process -Property ProcessId,ParentProcessId -ErrorAction Stop)
      Write-RudderHelperPhase $requestId "snapshot_query_done"
      $owned = [System.Collections.Generic.HashSet[int]]::new()
      [void]$owned.Add([int]$request.pid)
      $changed = $true
      while ($changed) {
        $changed = $false
        foreach ($entry in $all) {
          if (-not $owned.Contains([int]$entry.ProcessId) -and $owned.Contains([int]$entry.ParentProcessId)) {
            [void]$owned.Add([int]$entry.ProcessId)
            $changed = $true
          }
        }
      }
      $result = @($all | Where-Object { $owned.Contains([int]$_.ProcessId) } | ForEach-Object {
        try {
          Write-RudderHelperPhase $requestId "get_process_start"
          $candidate = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
          Write-RudderHelperPhase $requestId "get_process_done"
          $createdAt = Get-RudderCreationTime -handle $candidate.SafeHandle -requestId $requestId
          @{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; CreationTime = $createdAt }
        } catch { Write-RudderHelperPhase $requestId "snapshot_process_failed" }
      })
    } elseif ($request.type -eq 'terminate') {
      $held = @()
      $result = @()
      foreach ($entry in @($request.processes)) {
        try {
          Write-RudderHelperPhase $requestId "get_process_start"
          $candidate = Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
          Write-RudderHelperPhase $requestId "get_process_done"
          $handle = $candidate.SafeHandle
          $actual = Get-RudderCreationTime -handle $handle -requestId $requestId
          if ($actual -ne [string]$entry.createdAt) {
            $result += @{ pid = [int]$entry.pid; status = 'replacement' }
          } else {
            $held += @{ pid = [int]$entry.pid; process = $candidate; handle = $handle }
          }
        } catch {
          Write-RudderHelperPhase $requestId "terminate_process_lookup_failed"
          $result += @{ pid = [int]$entry.pid; status = 'gone' }
        }
      }
      foreach ($entry in $held) {
        try {
          if ($entry.process.HasExited) {
            $result += @{ pid = $entry.pid; status = 'gone' }
          } else {
            if (-not $terminateProcess.Invoke($null, @($entry.handle, 1))) { throw 'TerminateProcess failed' }
            if (-not $entry.process.WaitForExit(5000)) { throw 'Process handle wait timed out' }
            $result += @{ pid = $entry.pid; status = 'terminated' }
          }
        } catch { $result += @{ pid = $entry.pid; status = 'failed' } }
      }
    } else { throw 'Unknown helper request' }
    $response = @{ id = [int]$request.id; ok = $true; result = $result }
  } catch {
    Write-RudderHelperPhase $requestId "request_failed"
    $response = @{ id = $requestId; ok = $false; error = 'Windows process helper request failed' }
  }
  Write-RudderHelperPhase $requestId "response_serialize_start"
  $responseLine = $response | ConvertTo-Json -Compress -Depth 6
  Write-RudderHelperPhase $requestId "response_flush_start"
  [Console]::Out.WriteLine($responseLine)
  [Console]::Out.Flush()
  Write-RudderHelperPhase $requestId "response_flush_done"
}
`;

let defaultController;

function isWindowsHelperProcessAlive(pid) {
  if (!Number.isSafeInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

function describeWindowsHelperStderr(stderr) {
  if (!stderr) return "empty";
  const digest = createHash("sha256").update(stderr).digest("hex").slice(0, 12);
  return `redacted:${Buffer.byteLength(stderr, "utf8")}B:sha256=${digest}`;
}

function describeWindowsHelperState(child, isProcessAlive) {
  if (child.exitCode !== null || child.signalCode !== null) return "exited";
  try {
    const alive = isProcessAlive(child.pid);
    return alive === true ? "alive" : alive === false ? "not-alive" : "unknown";
  } catch {
    return "unknown";
  }
}

function formatWindowsHelperTrace(events, requestId) {
  const relevant = events.filter((event) => event.id === requestId || event.id === 0).slice(-12);
  return relevant.length === 0
    ? "none"
    : relevant.map((event) => `${event.id}:${event.source}:${event.phase}@${event.clock}`).join(",");
}

export async function terminateWindowsChildProcessHandle(childProcess, options = {}) {
  if (!childProcess || typeof childProcess.kill !== "function") {
    throw new Error("Windows Local App child process handle is unavailable");
  }
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return "already-exited";

  const timeoutMs = Math.max(1, options.timeoutMs ?? 2_000);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      childProcess.removeListener?.("exit", onExit);
      childProcess.removeListener?.("error", onError);
      if (error) reject(error);
      else resolve(result);
    };
    const onExit = () => finish(null, "exit-after-signal");
    const onError = () => finish(new Error("Windows Local App child process handle failed"));

    childProcess.once("exit", onExit);
    childProcess.once("error", onError);
    timeout = setTimeout(
      () => finish(new Error("Windows Local App child process handle did not exit in time")),
      timeoutMs,
    );
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
      finish(null, "already-exited");
      return;
    }
    try {
      // The ChildProcess object is the ownership handle; do not fall back to its PID.
      if (!childProcess.kill("SIGKILL")) {
        if (childProcess.exitCode !== null || childProcess.signalCode !== null) finish(null, "already-exited");
        else finish(new Error("Windows Local App child process handle refused termination"));
      }
    } catch {
      finish(new Error("Windows Local App child process handle termination failed"));
    }
  });
}

export async function failClosedWindowsProcessTreeCleanup(childProcess, identityError, options = {}) {
  const rootPid = isSafeLocalAppProcessId(childProcess?.pid) ? childProcess.pid : "unknown";
  let directChild = "unverified";
  let cleanupError = null;
  try {
    directChild = await terminateWindowsChildProcessHandle(childProcess, options);
  } catch (error) {
    cleanupError = error;
  }

  const message = `Windows Local App process tree cleanup remains unverified (rootPid=${rootPid}; rootCreationTime=unavailable; directChild=${directChild}; descendants=unverified)`;
  const cause = cleanupError
    ? new AggregateError([identityError, cleanupError], "Windows Local App identity and cleanup failed")
    : identityError;
  throw new Error(message, { cause });
}

export function createWindowsProcessController(options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const isProcessAlive = options.isProcessAlive ?? isWindowsHelperProcessAlive;
  const child = spawnProcess(powershellPath(options.systemRoot), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_HELPER_SCRIPT,
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.unref();
  child.stdin.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  let stderrPhaseBuffer = "";
  const phases = [];
  const recordPhase = (source, id, phase, clock = process.hrtime.bigint().toString()) => {
    const event = { source, id, phase, clock };
    phases.push(event);
    if (phases.length > WINDOWS_HELPER_TRACE_LIMIT) phases.shift();
    try { options.observePhase?.(event); } catch { /* Diagnostics must not affect process control. */ }
  };
  const rejectPending = (id, error) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timeout);
    entry.reject(error);
  };
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const startTimeout = setTimeout(
    () => readyReject(new Error("Windows process helper did not start in time")),
    WINDOWS_HELPER_START_TIMEOUT_MS,
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const value = String(chunk);
    stderr = `${stderr}${value}`.slice(-8_192);
    stderrPhaseBuffer += value;
    if (stderrPhaseBuffer.length > 4_096) stderrPhaseBuffer = stderrPhaseBuffer.slice(-2_048);
    let newlineIndex = stderrPhaseBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stderrPhaseBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stderrPhaseBuffer = stderrPhaseBuffer.slice(newlineIndex + 1);
      const match = WINDOWS_HELPER_PHASE_MARKER_PATTERN.exec(line);
      if (match) recordPhase("powershell", Number(match[1]), match[2], match[3]);
      newlineIndex = stderrPhaseBuffer.indexOf("\n");
    }
  });
  child.stdin.on?.("error", () => {
    for (const id of pending.keys()) {
      recordPhase("node", id, "request_stdin_error");
      rejectPending(id, new Error("Windows process helper request write failed"));
    }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch {
      recordPhase("node", 0, "stdout_json_parse_invalid");
      return;
    }
    if (message?.id === 0 && message.ok === true) {
      recordPhase("node", 0, "ready_frame_parsed");
      clearTimeout(startTimeout);
      readyResolve();
      return;
    }
    const entry = pending.get(message?.id);
    if (!entry) {
      recordPhase("node", Number.isSafeInteger(message?.id) ? message.id : 0, "stdout_response_unmatched");
      return;
    }
    recordPhase("node", message.id, message.ok === true ? "stdout_response_matched_ok" : "stdout_response_matched_error");
    pending.delete(message.id);
    clearTimeout(entry.timeout);
    if (message.ok === true) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? "Windows process helper request failed"));
  });
  child.once("error", (error) => {
    clearTimeout(startTimeout);
    readyReject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(startTimeout);
    const error = new Error(`Windows process helper exited (${code ?? "signal"})${stderr ? `: ${stderr.trim()}` : ""}`);
    readyReject(error);
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
  });
  return {
    async request(type, payload) {
      await ready;
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          recordPhase("node", id, "request_timeout");
          const helperState = describeWindowsHelperState(child, isProcessAlive);
          let helperStop = "signal-failed";
          try {
            // This child is owned by the controller; never resolve it again from a PID.
            helperStop = child.kill("SIGKILL") ? "signal-accepted" : "signal-refused";
          } catch {
            helperStop = "signal-failed";
          }
          recordPhase("node", id, `helper_stop_${helperStop.replaceAll("-", "_")}`);
          reject(new Error(
            `Windows process helper request timed out (type=${type}, id=${id}, helperPid=${child.pid ?? "unknown"}, helperState=${helperState}, helperStop=${helperStop}, helperExit=unverified, stderr=${describeWindowsHelperStderr(stderr)}, phases=${formatWindowsHelperTrace(phases, id)})`,
          ));
        }, options.requestTimeoutMs ?? WINDOWS_HELPER_REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timeout });
        const requestLine = `${JSON.stringify({ id, type, ...payload })}\n`;
        recordPhase("node", id, "request_write_start");
        try {
          const accepted = child.stdin.write(requestLine, (error) => {
            recordPhase("node", id, error ? "request_write_callback_error" : "request_write_callback_ok");
            if (error) rejectPending(id, new Error("Windows process helper request write failed"));
          });
          recordPhase("node", id, accepted ? "request_write_accepted" : "request_write_backpressured");
        } catch {
          recordPhase("node", id, "request_write_threw");
          rejectPending(id, new Error("Windows process helper request write failed"));
        }
      });
    },
  };
}

function windowsProcessController(options = {}) {
  defaultController ??= createWindowsProcessController(options);
  return defaultController;
}

export function windowsProcessTreeSnapshotCommand(rootPid) {
  if (!isSafeLocalAppProcessId(rootPid)) throw new Error("Invalid Windows process identity");
  return [
  "$samples = (Get-Counter '\\Process(*)\\ID Process','\\Process(*)\\Creating Process ID' -ErrorAction Stop).CounterSamples",
  "$byInstance = @{}",
  "$samples | ForEach-Object { if (-not $byInstance.ContainsKey($_.InstanceName)) { $byInstance[$_.InstanceName] = [ordered]@{} }; if ($_.Path.EndsWith('\\id process')) { $byInstance[$_.InstanceName].ProcessId = [int]$_.CookedValue } elseif ($_.Path.EndsWith('\\creating process id')) { $byInstance[$_.InstanceName].ParentProcessId = [int]$_.CookedValue } }",
  "$rows = @($byInstance.Values | Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.ParentProcessId })",
  `$owned = [System.Collections.Generic.HashSet[int]]::new(); [void]$owned.Add(${rootPid})`,
  "$changed = $true; while ($changed) { $changed = $false; foreach ($row in $rows) { if (-not $owned.Contains([int]$row.ProcessId) -and $owned.Contains([int]$row.ParentProcessId)) { [void]$owned.Add([int]$row.ProcessId); $changed = $true } } }",
  "$records = @($rows | Where-Object { $owned.Contains([int]$_.ProcessId) } | ForEach-Object { try { $candidate = Get-Process -Id $_.ProcessId -ErrorAction Stop; [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CreationTime = $candidate.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } } catch {} })",
  "$records | ConvertTo-Json -Compress",
  ].join("; ");
}

export function windowsProcessCreationCommand(processId) {
  if (!isSafeLocalAppProcessId(processId)) throw new Error("Invalid Windows process identity");
  return `Get-Process -Id ${processId} -ErrorAction Stop | Select-Object @{Name='CreationTime';Expression={$_.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}} | ConvertTo-Json -Compress`;
}

export function parseWindowsProcessTable(output) {
  try {
    const parsed = JSON.parse(String(output).trim());
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const result = rows.flatMap((row) => {
      const pid = Number(row?.ProcessId);
      const parentPid = Number(row?.ParentProcessId);
      const createdAt = row?.CreationTime;
      if (pid === 0 && parentPid === 0) return [];
      if (!isSafeLocalAppProcessId(pid)
        || !Number.isSafeInteger(parentPid)
        || parentPid < 0
        || typeof createdAt !== "string"
        || createdAt.length === 0) {
        throw new Error("Invalid Windows process snapshot");
      }
      return [{ pid, parentPid, createdAt }];
    });
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

function powershellPath(systemRoot) {
  return path.win32.join(
    systemRoot ?? process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function runPowerShell(command, options = {}) {
  const execute = options.execFileAsync ?? (async (executable, args, execOptions) => {
    const result = await defaultExecFile(executable, args, execOptions);
    return { stdout: result.stdout };
  });
  return execute(powershellPath(options.systemRoot), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], {
    windowsHide: true,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
  });
}

export async function captureWindowsProcessCreationTime(processId, options = {}) {
  if (!options.execFileAsync) {
    const result = await windowsProcessController(options).request("capture", { pid: processId });
    if (result?.pid !== processId
      || typeof result?.createdAt !== "string"
      || !/^\d+$/.test(result.createdAt)) {
      throw new Error("Invalid Windows process identity");
    }
    return result.createdAt;
  }
  const { stdout } = await runPowerShell(windowsProcessCreationCommand(processId), {
    ...options,
    maxBuffer: 16 * 1024,
  });
  const parsed = JSON.parse(String(stdout).trim());
  if (typeof parsed?.CreationTime !== "string" || !/^\d+$/.test(parsed.CreationTime)) {
    throw new Error("Invalid Windows process identity");
  }
  return parsed.CreationTime;
}

export async function captureManagedWindowsProcessIdentity(
  childProcess,
  capture = captureWindowsProcessCreationTime,
) {
  const processId = childProcess?.pid;
  if (!isSafeLocalAppProcessId(processId)) throw new Error("Invalid Windows process identity");
  const createdAt = await capture(processId);
  if (childProcess.pid !== processId
    || childProcess.exitCode !== null
    || childProcess.signalCode !== null) {
    throw new Error("Managed Local App root exited before its identity was captured");
  }
  return { pid: processId, createdAt };
}

export async function snapshotWindowsProcesses(rootPid, options = {}) {
  if (!options.execFileAsync) {
    const result = await windowsProcessController(options).request("snapshot", { pid: rootPid });
    if (Array.isArray(result) && result.length === 0) return [];
    const processTable = parseWindowsProcessTable(JSON.stringify(result));
    if (!processTable) throw new Error("Invalid Windows process snapshot");
    return processTable;
  }
  const { stdout } = await runPowerShell(windowsProcessTreeSnapshotCommand(rootPid), options);
  if (String(stdout).trim() === "[]") return [];
  const processTable = parseWindowsProcessTable(stdout);
  if (!processTable) throw new Error("Invalid Windows process snapshot");
  return processTable;
}

export function windowsTerminateInstancesCommand(processes) {
  const serialized = Buffer.from(JSON.stringify(processes), "utf8").toString("base64");
  return `
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RudderWindowsProcessNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct FileTime { public uint Low; public uint High; }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(SafeProcessHandle process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);

  public static string CreationTime(SafeProcessHandle process) {
    FileTime creation, exit, kernel, user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    ulong value = ((ulong)creation.High << 32) | creation.Low;
    return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
}
'@
Add-Type -TypeDefinition $nativeSource
$expected = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${serialized}')) | ConvertFrom-Json)
$held = @()
$results = @()
foreach ($entry in $expected) {
  try {
    $candidate = Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
    $handle = $candidate.SafeHandle
    $actual = [RudderWindowsProcessNative]::CreationTime($handle)
    if ($actual -ne [string]$entry.createdAt) {
      $results += [pscustomobject]@{ pid = [int]$entry.pid; status = 'replacement' }
    } else {
      $held += [pscustomobject]@{ pid = [int]$entry.pid; process = $candidate; handle = $handle }
    }
  } catch {
    $results += [pscustomobject]@{ pid = [int]$entry.pid; status = 'gone' }
  }
}
foreach ($entry in $held) {
  try {
    if ([RudderWindowsProcessNative]::WaitForSingleObject($entry.handle, 0) -eq 0) {
      $results += [pscustomobject]@{ pid = $entry.pid; status = 'gone' }
      continue
    }
    if (-not [RudderWindowsProcessNative]::TerminateProcess($entry.handle, 1)) {
      throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    if ([RudderWindowsProcessNative]::WaitForSingleObject($entry.handle, 5000) -ne 0) {
      throw "Timed out waiting for process handle"
    }
    $results += [pscustomobject]@{ pid = $entry.pid; status = 'terminated' }
  } catch {
    $results += [pscustomobject]@{ pid = $entry.pid; status = 'failed' }
  }
}
$results | ConvertTo-Json -Compress
`;
}

export async function terminateWindowsProcessInstances(processes, options = {}) {
  if (!Array.isArray(processes)
    || processes.length === 0
    || processes.some((entry) => !isSafeLocalAppProcessId(entry?.pid)
      || typeof entry?.createdAt !== "string"
      || !/^\d+$/.test(entry.createdAt))) {
    throw new Error("Invalid Windows process termination authority");
  }
  const rawResults = options.execFileAsync
    ? JSON.parse(String((await runPowerShell(windowsTerminateInstancesCommand(processes), {
        ...options,
        timeoutMs: options.timeoutMs ?? 30_000,
      })).stdout).trim())
    : await windowsProcessController(options).request("terminate", { processes });
  const results = Array.isArray(rawResults) ? rawResults : [rawResults];
  if (results.length !== processes.length
    || results.some((entry) => !["gone", "replacement", "terminated"].includes(entry?.status))) {
    throw new Error("Windows Local App process-handle termination failed");
  }
}
