import pc from "picocolors";

const RUDDER_ART = [
  "██████╗ ██╗   ██╗██████╗ ██████╗ ███████╗██████╗ ",
  "██╔══██╗██║   ██║██╔══██╗██╔══██╗██╔════╝██╔══██╗",
  "██████╔╝██║   ██║██║  ██║██║  ██║█████╗  ██████╔╝",
  "██╔══██╗██║   ██║██║  ██║██║  ██║██╔══╝  ██╔══██╗",
  "██║  ██║╚██████╔╝██████╔╝██████╔╝███████╗██║  ██║",
  "╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
] as const;

const TAGLINE = "Assign, run, review, and improve agent work";
const DESCRIPTION = [
  "Connect goals, tasks, runs, budgets, feedback, and learning",
  "Keep agent work visible, reviewable, and tied to real outcomes",
] as const;

export function printRudderCliBanner(): void {
  const lines = [
    "",
    ...RUDDER_ART.map((line) => pc.cyan(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    ...DESCRIPTION.map((line) => pc.white(`  ${line}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
