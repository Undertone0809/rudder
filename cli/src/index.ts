import { runCli } from "./program.js";
import { flushProcessOutputBeforeExit } from "./stdio.js";

export { runCli } from "./program.js";

void runCli(process.argv).then(async (exitCode) => {
  // Ensure stdio is fully flushed before exiting. Heartbeat runtimes invoke the
  // CLI through pipes, where a forced process.exit can otherwise win a race
  // against asynchronous stdout writes and produce empty output or, on Windows,
  // trip libuv assertions while handles are closing.
  await flushProcessOutputBeforeExit();
  process.exitCode = exitCode;
});
