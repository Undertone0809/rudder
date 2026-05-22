import { runCli } from "./program.js";
import { flushProcessOutputBeforeExit } from "./stdio.js";

export { runCli } from "./program.js";

void runCli(process.argv).then(async (exitCode) => {
  // Ensure stdio is fully flushed before exiting. Heartbeat runtimes invoke the
  // CLI through pipes, where process.exit can otherwise win a race against
  // asynchronous stdout writes and produce an exit-0 command with empty output.
  await flushProcessOutputBeforeExit();
  process.exit(exitCode);
});
