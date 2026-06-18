export type WorkspaceCsvParseResult = {
  rows: string[][];
  lineEnding: "\n" | "\r\n";
  hasTrailingLineBreak: boolean;
};

function detectWorkspaceCsvLineEnding(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function parseWorkspaceCsvContent(content: string): WorkspaceCsvParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let hasTrailingLineBreak = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    hasTrailingLineBreak = false;

    if (inQuotes) {
      if (char === "\"") {
        if (content[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"" && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      hasTrailingLineBreak = true;
      if (char === "\r" && content[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }
    field += char;
  }

  if (row.length > 0 || field.length > 0 || !hasTrailingLineBreak) {
    row.push(field);
    rows.push(row);
  }

  return {
    rows: rows.length > 0 ? rows : [[""]],
    lineEnding: detectWorkspaceCsvLineEnding(content),
    hasTrailingLineBreak,
  };
}

function serializeWorkspaceCsvField(field: string) {
  if (/[",\r\n]/u.test(field)) {
    return `"${field.replaceAll("\"", "\"\"")}"`;
  }
  return field;
}

export function serializeWorkspaceCsvRows(
  rows: string[][],
  lineEnding: "\n" | "\r\n" = "\n",
  hasTrailingLineBreak = false,
) {
  const content = rows
    .map((row) => row.map(serializeWorkspaceCsvField).join(","))
    .join(lineEnding);
  return hasTrailingLineBreak && content.length > 0 ? `${content}${lineEnding}` : content;
}
