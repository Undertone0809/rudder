import { execFile } from "node:child_process";

type SecurityCommandExecutor = (
  file: string,
  args: string[],
  options: {
    encoding: "buffer";
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
  },
  callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
) => unknown;

function runSecurityCommand(
  args: string[],
  execute: SecurityCommandExecutor = execFile as unknown as SecurityCommandExecutor,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execute("/usr/bin/security", args, {
      encoding: "buffer",
      maxBuffer: 8 * 1024,
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        stdout.fill(0);
        stderr.fill(0);
        reject(error);
        return;
      }
      stderr.fill(0);
      resolve(stdout);
    });
  });
}

export async function readMacBrowserKeychainPassword(
  keychain: { service: string; account: string },
  options: {
    runSecurity?: (args: string[]) => Promise<Buffer>;
    execSecurity?: SecurityCommandExecutor;
  } = {},
): Promise<Buffer> {
  let output: Buffer | null = null;
  try {
    const runSecurity = options.runSecurity ?? ((args: string[]) => runSecurityCommand(args, options.execSecurity));
    output = await runSecurity([
      "find-generic-password",
      "-w",
      "-s",
      keychain.service,
      "-a",
      keychain.account,
    ]);
    let end = output.length;
    while (end > 0 && (output[end - 1] === 0x0a || output[end - 1] === 0x0d)) end -= 1;
    if (end === 0 || end > 4_096) throw new Error("invalid keychain output");
    return Buffer.from(output.subarray(0, end));
  } catch (error) {
    if (error && typeof error === "object") {
      const childError = error as { stdout?: unknown; stderr?: unknown };
      if (Buffer.isBuffer(childError.stdout)) childError.stdout.fill(0);
      if (Buffer.isBuffer(childError.stderr)) childError.stderr.fill(0);
    }
    throw new Error("Browser Keychain access was denied or unavailable.");
  } finally {
    output?.fill(0);
  }
}
