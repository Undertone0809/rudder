import { buildAgentV1McpToolsManifest } from "./agent-v1-registry.js";

export function validateMcpToolArguments(toolName: string, input: Record<string, unknown>): void {
  const tool = buildAgentV1McpToolsManifest("agent-v1", { surface: "all" }).tools
    .find((entry) => entry.name === toolName);
  if (!tool) return;

  const schema = tool.inputSchema as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    const property = String(key);
    if (!Object.prototype.hasOwnProperty.call(input, property) || input[property] === undefined) {
      throwInvalidMcpArgument(toolName, property, "is required");
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => {
      if (!isRecord(candidate) || !Array.isArray(candidate.required)) return false;
      return candidate.required.every((key) => {
        const property = String(key);
        return Object.prototype.hasOwnProperty.call(input, property) && input[property] !== undefined;
      });
    });
    if (!matches) {
      const alternatives = schema.anyOf
        .flatMap((candidate) => isRecord(candidate) && Array.isArray(candidate.required) ? candidate.required : [])
        .map(String);
      throwInvalidMcpArgument(toolName, alternatives.join(" or "), "is required");
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!isRecord(property) || value === undefined) continue;
    const violation = jsonSchemaViolation(value, property);
    if (violation) throwInvalidMcpArgument(toolName, key, violation);
  }
}

function jsonSchemaViolation(value: unknown, schema: Record<string, unknown>): string | null {
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) =>
      isRecord(candidate) && jsonSchemaViolation(value, candidate) === null
    );
    if (!matches) return "does not match any allowed shape";
  }
  if (Array.isArray(schema.oneOf)) {
    const matchingBranches = schema.oneOf.filter((candidate) =>
      isRecord(candidate) && jsonSchemaViolation(value, candidate) === null
    ).length;
    if (matchingBranches !== 1) return "does not match exactly one allowed shape";
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.length > 0) {
    const validType = types.some((type) => (
      type === "string" ? typeof value === "string"
        : type === "number" ? typeof value === "number" && Number.isFinite(value)
          : type === "integer" ? typeof value === "number" && Number.isInteger(value)
            : type === "boolean" ? typeof value === "boolean"
              : type === "array" ? Array.isArray(value)
                : type === "object" ? isRecord(value)
                  : type === "null" ? value === null
                    : false
    ));
    if (!validType) return `must be ${types.join(" or ")}`;
  }

  if (typeof value === "string") {
    const characterLength = Array.from(value).length;
    if (typeof schema.minLength === "number" && characterLength < schema.minLength) {
      return `must contain at least ${schema.minLength} character(s)`;
    }
    if (typeof schema.maxLength === "number" && characterLength > schema.maxLength) {
      return `must contain at most ${schema.maxLength} characters`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return `must be one of: ${schema.enum.join(", ")}`;
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `must be at least ${schema.minimum}`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `must be at most ${schema.maximum}`;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `must contain at least ${schema.minItems} items`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `must contain at most ${schema.maxItems} items`;
    }
    if (isRecord(schema.items)) {
      for (const [index, item] of value.entries()) {
        const violation = jsonSchemaViolation(item, schema.items);
        if (violation) return `item ${index} ${violation}`;
      }
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
      return `must contain at least ${schema.minProperties} propert${schema.minProperties === 1 ? "y" : "ies"}`;
    }
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `field ${key} is required`;
    }
    if (schema.additionalProperties === false) {
      const unsupported = Object.keys(value).filter((key) => !(key in properties));
      if (unsupported.length > 0) return `contains unsupported field(s): ${unsupported.sort().join(", ")}`;
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (!isRecord(childSchema)) continue;
      const violation = jsonSchemaViolation(child, childSchema);
      if (violation) return `field ${key} ${violation}`;
    }
  }
  return null;
}

export function throwInvalidMcpArgument(toolName: string, key: string, reason: string): never {
  const err = new Error(`Invalid argument for ${toolName}: ${key} ${reason}. Consult tools/list for the exact schema.`);
  (err as Error & { code?: string }).code = "rudder_mcp_invalid_arguments";
  throw err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
