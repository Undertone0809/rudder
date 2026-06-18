export interface HelpNotes {
  examples?: Array<string | HelpExample>;
  cautions?: string[];
}

export interface HelpExample {
  description: string;
  command: string;
}

export function formatExamplesAndCautions(notes: HelpNotes): string {
  const sections: string[] = [];

  if (notes.examples?.length) {
    sections.push(["Examples:", ...notes.examples.map(formatHelpExample)].join("\n"));
  }

  if (notes.cautions?.length) {
    sections.push(["Cautions:", ...notes.cautions.map((caution) => `  - ${caution}`)].join("\n"));
  }

  return sections.length > 0 ? `\n${sections.join("\n\n")}` : "";
}

function formatHelpExample(example: string | HelpExample): string {
  if (typeof example === "string") {
    return `  ${example}`;
  }
  return `  ${example.description}\n    ${example.command}`;
}
