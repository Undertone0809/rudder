export interface HelpNotes {
  examples?: string[];
  cautions?: string[];
}

export function formatExamplesAndCautions(notes: HelpNotes): string {
  const sections: string[] = [];

  if (notes.examples?.length) {
    sections.push(["Examples:", ...notes.examples.map((example) => `  ${example}`)].join("\n"));
  }

  if (notes.cautions?.length) {
    sections.push(["Cautions:", ...notes.cautions.map((caution) => `  - ${caution}`)].join("\n"));
  }

  return sections.length > 0 ? `\n${sections.join("\n\n")}` : "";
}
