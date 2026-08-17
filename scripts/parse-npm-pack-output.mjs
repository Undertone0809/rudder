import { readFileSync } from "node:fs";

export function extractNpmPackFilename(output) {
  for (let start = output.lastIndexOf("["); start >= 0; start = output.lastIndexOf("[", start - 1)) {
    const candidate = findJsonArray(output, start);
    if (!candidate) continue;

    try {
      const parsed = JSON.parse(candidate);
      const filename = parsed?.[0]?.filename;
      if (Array.isArray(parsed) && typeof filename === "string" && filename.length > 0) {
        return filename;
      }
    } catch {
      // Lifecycle output can contain bracket-like text before the JSON payload.
    }
  }

  throw new Error("npm pack output did not contain a JSON payload with a filename");
}

function findJsonArray(input, start) {
  const stack = [];
  let quoted = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char !== "]" && char !== "}") continue;

    const opening = stack.pop();
    if ((char === "]" && opening !== "[") || (char === "}" && opening !== "{")) {
      return null;
    }
    if (stack.length === 0) return input.slice(start, index + 1);
  }

  return null;
}

if (process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname) {
  process.stdout.write(`${extractNpmPackFilename(readFileSync(0, "utf8"))}\n`);
}
