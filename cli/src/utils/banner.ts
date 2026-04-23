import pc from "picocolors";

const RUDDER_ART = [
  "██████╗ ██╗   ██╗██████╗ ██████╗ ███████╗██████╗ ",
  "██╔══██╗██║   ██║██╔══██╗██╔══██╗██╔════╝██╔══██╗",
  "██████╔╝██║   ██║██║  ██║██║  ██║█████╗  ██████╔╝",
  "██╔══██╗██║   ██║██║  ██║██║  ██║██╔══╝  ██╔══██╗",
  "██║  ██║╚██████╔╝██████╔╝██████╔╝███████╗██║  ██║",
  "╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
] as const;

const TAGLINE = "Orchestration and control platform for agent work";
const DESCRIPTION = [
  "Operating layer for agent teams",
  "Goals, tasks, knowledge, and workflows in an executable structure",
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
