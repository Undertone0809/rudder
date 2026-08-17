function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildWindowsZipExtractCommand(zipPath: string, outputDir: string): { command: string; args: string[] } {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${powershellQuote(zipPath)} -DestinationPath ${powershellQuote(outputDir)} -Force`,
    ],
  };
}

export { powershellQuote };
