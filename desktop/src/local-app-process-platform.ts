import { execFile } from "node:child_process";
import { access, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isSafeLocalAppProcessId } from "./local-app-process-identity.mjs";
import {
  isLocalAppOwnerAlive,
  terminateLocalAppOwner,
} from "./local-app-process-platform-shared.mjs";
import {
  parseWindowsProcessTable as parseWindowsProcessTableOutput,
  snapshotWindowsProcesses as snapshotWindowsProcessTable,
  terminateWindowsProcessInstances as terminateWindowsProcessHandles
} from "./local-app-windows-processes.mjs";

const defaultExecFile = promisify(execFile);
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 30_000;

export type LocalAppLivenessState = "alive" | "dead" | "unknown";

export interface LocalAppPersistedRuntimeLiveness {
  pid: LocalAppLivenessState;
  processGroup: LocalAppLivenessState;
  listener: LocalAppLivenessState;
}

export interface LocalAppProcessPlatform {
  readonly platform: NodeJS.Platform;
  readonly systemPathEntries: string[];
  terminate(ownerId: number | null): Promise<void>;
  probePersistedRuntime(input: {
    pid: number | null;
    pgid: number | null;
    port: number | null;
  }): Promise<LocalAppPersistedRuntimeLiveness>;
  verifyListenerOwnership(input: {
    port: number;
    pid: number;
    pgid: number;
    timeoutMs: number;
  }): Promise<boolean>;
}

export interface LocalAppProcessPlatformOptions {
  platform?: NodeJS.Platform;
  execFileAsync?: (
    executable: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string | Buffer }>;
  killProcess?: typeof process.kill;
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  isGroupAlive?: (pgid: number) => boolean;
  isOwnerAlive?: (ownerId: number) => boolean;
  snapshotWindowsProcesses?: (rootPid: number) => Promise<WindowsProcessRecord[]>;
  terminateWindowsProcessInstances?: (processes: WindowsProcessRecord[]) => Promise<void>;
  delay?: (milliseconds: number) => Promise<void>;
  termTimeoutMs?: number;
  pollMs?: number;
  probeLoopbackListener?: (port: number | null) => Promise<LocalAppLivenessState>;
  systemRoot?: string;
}

export type LsofListenerProcessRecord = {
  pid: number;
  addresses: string[];
};

export type WindowsProcessRecord = {
  pid: number;
  parentPid: number;
  createdAt: string;
};

export function parseLsofListenerProcessRecords(
  output: string,
  port: number,
): LsofListenerProcessRecord[] | null {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const expectedAddress = `127.0.0.1:${port}`;
  const records: LsofListenerProcessRecord[] = [];
  const seenPids = new Set<number>();
  let current: LsofListenerProcessRecord | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (/^p\d+$/.test(line)) {
      if (current) {
        if (current.addresses.length === 0) return null;
        records.push(current);
      }
      const pid = Number.parseInt(line.slice(1), 10);
      if (!isSafeLocalAppProcessId(pid) || seenPids.has(pid)) return null;
      seenPids.add(pid);
      current = { pid, addresses: [] };
      continue;
    }
    if (/^f.+$/.test(line)) {
      if (!current) return null;
      continue;
    }
    if (line.startsWith("n")) {
      const address = line.slice(1);
      if (!current || address !== expectedAddress) return null;
      current.addresses.push(address);
      continue;
    }
    return null;
  }
  if (current) {
    if (current.addresses.length === 0) return null;
    records.push(current);
  }
  return records.length > 0 ? records : null;
}

export function parseWindowsProcessTable(
  output: string,
): WindowsProcessRecord[] | null {
  return parseWindowsProcessTableOutput(output) as WindowsProcessRecord[] | null;
}

export function descendantProcessIds(
  rootPid: number,
  processTable: Array<{ pid: number; parentPid: number }>,
): Set<number> {
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processRecord of processTable) {
      if (!descendants.has(processRecord.pid) && descendants.has(processRecord.parentPid)) {
        descendants.add(processRecord.pid);
        changed = true;
      }
    }
  }
  return descendants;
}

export function parseWindowsLoopbackListenerPids(
  output: string,
  port: number,
): number[] | null {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const listeners: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0]?.toUpperCase() !== "TCP" || fields[3]?.toUpperCase() !== "LISTENING") {
      continue;
    }
    const localAddress = fields[1]!;
    if (!localAddress.endsWith(`:${port}`)) continue;
    if (localAddress !== `127.0.0.1:${port}`) return null;
    const pid = Number.parseInt(fields[4]!, 10);
    if (!isSafeLocalAppProcessId(pid)) return null;
    listeners.push(pid);
  }
  return listeners.length > 0 ? [...new Set(listeners)] : null;
}

export function parseLinuxTcpListenerInodes(
  output: string,
  port: number,
): string[] | null {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes: string[] = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const [address, candidatePort] = (fields[1] ?? "").split(":");
    if (candidatePort?.toUpperCase() !== expectedPort) continue;
    if (address?.toUpperCase() !== "0100007F") return null;
    const inode = fields[9];
    if (!inode || !/^\d+$/.test(inode)) return null;
    inodes.push(inode);
  }
  return inodes.length > 0 ? [...new Set(inodes)] : null;
}

function processLiveness(
  processId: number | null,
  platform: NodeJS.Platform,
  killProcess: typeof process.kill,
  processGroup = false,
): LocalAppLivenessState {
  if (!isSafeLocalAppProcessId(processId)) return "unknown";
  try {
    killProcess(platform !== "win32" && processGroup ? -processId : processId, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

async function executablePath(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next fixed system path.
    }
  }
  return candidates[0]!;
}

export function createLocalAppProcessPlatform(
  options: LocalAppProcessPlatformOptions = {},
): LocalAppProcessPlatform {
  const platform = options.platform ?? process.platform;
  const execute = options.execFileAsync ?? (async (executable, args, execOptions) => {
    const result = await defaultExecFile(executable, args, execOptions);
    return { stdout: result.stdout };
  });
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const windowsSystem32 = path.win32.join(systemRoot, "System32");
  const systemPathEntries = platform === "win32"
    ? [windowsSystem32, systemRoot]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const reportedWindowsOwnershipFailures = new Set<string>();
  const reportedLinuxOwnershipFailures = new Set<string>();
  const verifiedWindowsOwnerCreationDates = new Map<number, string>();
  const verifiedWindowsOwnedProcesses = new Map<number, WindowsProcessRecord[]>();
  const snapshotWindowsProcesses = options.snapshotWindowsProcesses ?? ((rootPid: number) => (
    snapshotWindowsProcessTable(rootPid, {
      ...(options.execFileAsync ? { execFileAsync: execute } : {}),
      systemRoot,
      timeoutMs: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
    }) as Promise<WindowsProcessRecord[]>
  ));
  const terminateWindowsProcessInstances = options.terminateWindowsProcessInstances
    ?? ((processes: WindowsProcessRecord[]) => terminateWindowsProcessHandles(processes, {
      ...(options.execFileAsync ? { execFileAsync: execute } : {}),
      systemRoot,
    }));

  const verifyPosixListenerOwnership = async (input: {
    port: number;
    pid: number;
    pgid: number;
  }): Promise<boolean> => {
    try {
      const psPath = await executablePath(["/bin/ps", "/usr/bin/ps"]);
      const processTableResult = await execute(psPath, ["-axo", "pid=,pgid="], {
        timeout: 2_000,
        maxBuffer: 256 * 1024,
      });
      const processGroupPids = String(processTableResult.stdout)
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
          if (!match || Number.parseInt(match[2]!, 10) !== input.pgid) return [];
          const pid = Number.parseInt(match[1]!, 10);
          return isSafeLocalAppProcessId(pid) ? [pid] : [];
        });
      if (!processGroupPids.includes(input.pid) || processGroupPids.length === 0) return false;

      const lsofPath = await executablePath(["/usr/sbin/lsof", "/usr/bin/lsof"]);
      const { stdout } = await execute(lsofPath, [
        "-nP",
        "-a",
        `-iTCP:${input.port}`,
        "-sTCP:LISTEN",
        "-Fpn",
      ], { timeout: 15_000, maxBuffer: 64 * 1024 });
      const listeners = parseLsofListenerProcessRecords(String(stdout), input.port);
      if (!listeners || listeners.some((listener) => !processGroupPids.includes(listener.pid))) {
        return false;
      }
      for (const listener of listeners) {
        const listenerResult = await execute(psPath, [
          "-o",
          "pgid=",
          "-p",
          String(listener.pid),
        ], { timeout: 2_000, maxBuffer: 16 * 1024 });
        if (Number.parseInt(String(listenerResult.stdout).trim(), 10) !== input.pgid) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  const verifyLinuxListenerOwnership = async (input: {
    port: number;
    pid: number;
    pgid: number;
  }): Promise<boolean> => {
    const rejectOwnership = (reason: string): false => {
      const diagnosticKey = `${reason}:${input.port}:${input.pid}:${input.pgid}`;
      if (!reportedLinuxOwnershipFailures.has(diagnosticKey)) {
        reportedLinuxOwnershipFailures.add(diagnosticKey);
        console.warn(
          `[local-app-ownership] Linux listener ownership rejected: ${reason} `
          + `(port=${input.port}, pid=${input.pid}, pgid=${input.pgid})`,
        );
      }
      return false;
    };
    try {
      const processGroupPids: number[] = [];
      for (const entry of await readdir("/proc", { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const pid = Number.parseInt(entry.name, 10);
        if (!isSafeLocalAppProcessId(pid)) continue;
        try {
          const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
          const commandEnd = processStat.lastIndexOf(")");
          if (commandEnd < 0) continue;
          const fields = processStat.slice(commandEnd + 1).trim().split(/\s+/);
          const processGroupId = Number.parseInt(fields[2] ?? "", 10);
          if (processGroupId === input.pgid) processGroupPids.push(pid);
        } catch {
          // The process may exit while /proc is being inspected.
        }
      }
      if (!processGroupPids.includes(input.pid)) return rejectOwnership("managed root was absent from process group");

      const tcpTables = await Promise.all([
        readFile("/proc/net/tcp", "utf8"),
        readFile("/proc/net/tcp6", "utf8").catch(() => ""),
      ]);
      const ipv4Inodes = parseLinuxTcpListenerInodes(tcpTables[0], input.port);
      if (!ipv4Inodes) return rejectOwnership("exact IPv4 loopback listener was absent");
      if (tcpTables[1].split(/\r?\n/).slice(1).some((line) => {
        const fields = line.trim().split(/\s+/);
        const [, candidatePort] = (fields[1] ?? "").split(":");
        return fields[3] === "0A"
          && candidatePort?.toUpperCase() === input.port.toString(16).toUpperCase().padStart(4, "0");
      })) {
        return rejectOwnership("IPv6 listener was present for the requested port");
      }

      const ownedInodes = new Set<string>();
      for (const pid of processGroupPids) {
        let descriptors;
        try {
          descriptors = await readdir(`/proc/${pid}/fd`);
        } catch {
          continue;
        }
        for (const descriptor of descriptors) {
          try {
            const target = await readlink(`/proc/${pid}/fd/${descriptor}`);
            const match = /^socket:\[(\d+)\]$/.exec(target);
            if (match) ownedInodes.add(match[1]!);
          } catch {
            // File descriptors are inherently racy; fail closed below.
          }
        }
      }
      return ipv4Inodes.every((inode) => ownedInodes.has(inode))
        ? true
        : rejectOwnership("listener socket inode was outside the managed process group");
    } catch {
      return rejectOwnership("process inspection failed");
    }
  };

  const verifyWindowsListenerOwnership = async (input: {
    port: number;
    pid: number;
    pgid: number;
    timeoutMs: number;
  }): Promise<boolean> => {
    const rejectOwnership = (reason: string): false => {
      if (!reportedWindowsOwnershipFailures.has(reason)) {
        reportedWindowsOwnershipFailures.add(reason);
        console.warn(`[local-app-ownership] Windows listener ownership rejected: ${reason}`);
      }
      return false;
    };
    try {
      if (input.pid !== input.pgid) return rejectOwnership("owner identity mismatch");
      const deadline = Date.now() + Math.max(1, input.timeoutMs);
      const remainingTimeout = (maximumMs: number) => Math.max(
        1,
        Math.min(maximumMs, deadline - Date.now()),
      );
      const processTable = await snapshotWindowsProcessTable(input.pid, {
        ...(options.execFileAsync ? { execFileAsync: execute } : {}),
        systemRoot,
        timeoutMs: remainingTimeout(WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS),
      }) as WindowsProcessRecord[];
      if (Date.now() >= deadline) return rejectOwnership("process snapshot exceeded deadline");
      const managedRoot = processTable.find((entry) => entry.pid === input.pid);
      if (!managedRoot) {
        return rejectOwnership("managed root was absent from process snapshot");
      }
      const ownedPids = descendantProcessIds(input.pid, processTable);
      const netstatResult = await execute(
        path.win32.join(windowsSystem32, "netstat.exe"),
        ["-ano", "-p", "tcp"],
        {
          timeout: remainingTimeout(5_000),
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      if (Date.now() >= deadline) return rejectOwnership("listener snapshot exceeded deadline");
      const listenerPids = parseWindowsLoopbackListenerPids(String(netstatResult.stdout), input.port);
      if (!listenerPids) return rejectOwnership("exact loopback listener was absent");
      if (!listenerPids.every((pid) => ownedPids.has(pid))) {
        return rejectOwnership("listener was outside the managed process tree");
      }
      verifiedWindowsOwnerCreationDates.set(input.pid, managedRoot.createdAt);
      verifiedWindowsOwnedProcesses.set(
        input.pid,
        processTable.filter((entry) => ownedPids.has(entry.pid)),
      );
      return true;
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
        ? "process inspection timed out"
        : "process inspection failed";
      return rejectOwnership(reason);
    }
  };

  return {
    platform,
    systemPathEntries,
    async terminate(ownerId) {
      const terminateKillProcess: typeof process.kill = platform !== "win32" && options.killGroup
        ? ((processId: number, signal?: number | NodeJS.Signals) => {
            if (!Number.isSafeInteger(processId) || processId >= 0 || typeof signal !== "string") {
              throw new Error("Invalid Local App process-group termination request");
            }
            options.killGroup!(-processId, signal);
            return true;
          }) as typeof process.kill
        : killProcess;
      await terminateLocalAppOwner(ownerId, {
        platform,
        killProcess: terminateKillProcess,
        isAlive: options.isOwnerAlive
          ?? (platform !== "win32" && options.isGroupAlive
            ? options.isGroupAlive
            : (value: number) => isLocalAppOwnerAlive(value, platform, killProcess)),
        delay: options.delay,
        termTimeoutMs: options.termTimeoutMs,
        pollMs: options.pollMs,
        expectedOwnerCreatedAt: platform === "win32" && ownerId !== null
          ? verifiedWindowsOwnerCreationDates.get(ownerId)
          : undefined,
        expectedWindowsProcesses: platform === "win32" && ownerId !== null
          ? verifiedWindowsOwnedProcesses.get(ownerId)
          : undefined,
        snapshotWindowsProcesses: platform === "win32" ? snapshotWindowsProcesses : undefined,
        terminateWindowsProcessInstances: platform === "win32"
          ? terminateWindowsProcessInstances
          : undefined,
      });
      if (platform === "win32" && ownerId !== null) {
        verifiedWindowsOwnerCreationDates.delete(ownerId);
        verifiedWindowsOwnedProcesses.delete(ownerId);
      }
    },
    async probePersistedRuntime(input) {
      return {
        pid: processLiveness(input.pid, platform, killProcess),
        processGroup: processLiveness(input.pgid, platform, killProcess, true),
        listener: options.probeLoopbackListener
          ? await options.probeLoopbackListener(input.port)
          : "unknown",
      };
    },
    verifyListenerOwnership: platform === "win32"
      ? verifyWindowsListenerOwnership
      : platform === "linux"
        ? verifyLinuxListenerOwnership
        : verifyPosixListenerOwnership,
  };
}
