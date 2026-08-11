import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { isSafeLocalAppProcessId } from "./local-app-process-identity.mjs";

const defaultExecFile = promisify(execFile);
const WINDOWS_HELPER_START_TIMEOUT_MS = 60_000;
const WINDOWS_HELPER_REQUEST_TIMEOUT_MS = 60_000;

const WINDOWS_HELPER_SCRIPT = `
$nativeType = [Diagnostics.Process].Assembly.GetType('Microsoft.Win32.NativeMethods')
$nativeFlags = [Reflection.BindingFlags]'Public,NonPublic,Static'
$getProcessTimes = $nativeType.GetMethod('GetProcessTimes', $nativeFlags)
$terminateProcess = $nativeType.GetMethod('TerminateProcess', $nativeFlags)
function Get-RudderCreationTime($handle) {
  $arguments = @($handle, [long]0, [long]0, [long]0, [long]0)
  if (-not $getProcessTimes.Invoke($null, $arguments)) { throw 'GetProcessTimes failed' }
  return ([long]$arguments[1]).ToString()
}
[Console]::Out.WriteLine('{"id":0,"ok":true}')
[Console]::Out.Flush()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    if ($request.type -eq 'capture') {
      $candidate = Get-Process -Id ([int]$request.pid) -ErrorAction Stop
      $result = @{ pid = [int]$request.pid; createdAt = Get-RudderCreationTime($candidate.SafeHandle) }
    } elseif ($request.type -eq 'snapshot') {
      $all = @(Get-WmiObject -Class Win32_Process -Property ProcessId,ParentProcessId -ErrorAction Stop)
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
          $candidate = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
          @{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; CreationTime = Get-RudderCreationTime($candidate.SafeHandle) }
        } catch { }
      })
    } elseif ($request.type -eq 'terminate') {
      $held = @()
      $result = @()
      foreach ($entry in @($request.processes)) {
        try {
          $candidate = Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
          $handle = $candidate.SafeHandle
          $actual = Get-RudderCreationTime($handle)
          if ($actual -ne [string]$entry.createdAt) {
            $result += @{ pid = [int]$entry.pid; status = 'replacement' }
          } else {
            $held += @{ pid = [int]$entry.pid; process = $candidate; handle = $handle }
          }
        } catch { $result += @{ pid = [int]$entry.pid; status = 'gone' } }
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
    $response = @{ id = [int]$request.id; ok = $false; error = 'Windows process helper request failed' }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
`;

let defaultController;

function createWindowsProcessController(options = {}) {
  const child = spawn(powershellPath(options.systemRoot), [
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
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.id === 0 && message.ok === true) {
      clearTimeout(startTimeout);
      readyResolve();
      return;
    }
    const entry = pending.get(message?.id);
    if (!entry) return;
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
          reject(new Error("Windows process helper request timed out"));
        }, WINDOWS_HELPER_REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
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
