import { spawn } from "node:child_process";
import electronBinary from "electron";

const args = [
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ...process.argv.slice(2),
];
const child = spawn(electronBinary, args, {
  env: process.env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Electron child exited with signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
