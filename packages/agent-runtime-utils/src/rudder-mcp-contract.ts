import {
  GENERATED_RUDDER_BROWSER_MCP_CONTRACT_HASH,
  GENERATED_RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_MCP_TOOL_DESCRIPTORS,
} from "./rudder-mcp-tool-descriptors.generated.js";

export const RUDDER_MCP_CONTRACT_VERSION = "rudder.agent-mcp-tools/v1";

export interface RudderMcpSemanticToolContract {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RudderMcpToolContractSource extends RudderMcpSemanticToolContract {
  mutating: boolean;
  requiresOrgId: boolean;
  requiresAgentId: boolean;
  attachesRunIdWhenAvailable: boolean;
}

function mcpString(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function mcpBoolean(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

function mcpNumber(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function mcpStringArray(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description };
}

function browserMcpInputSchema(id: string): {
  type: "object";
  additionalProperties: false;
  properties: Record<string, unknown>;
  required?: string[];
} {
  const string = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
  const number = (description: string, extra: Record<string, unknown> = {}) => ({ type: "number", description, ...extra });
  const boolean = (description: string) => ({ type: "boolean", description });
  const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object" as const,
    additionalProperties: false as const,
    properties,
    ...(required.length > 0 ? { required } : {}),
  });
  const locatorAtom = schema({
    strategy: string("Locator strategy.", { enum: ["css", "testId", "href", "role", "label", "placeholder", "text"] }),
    value: string("Selector, role, label, placeholder, href, test id, or text value.", { minLength: 1, maxLength: 2_000 }),
    name: string("Accessible name used with the role strategy.", { maxLength: 2_000 }),
    exact: boolean("Require an exact text or attribute match."),
  }, ["strategy", "value"]);
  const simpleLocator = schema({
    ...locatorAtom.properties,
    filter: schema({
      hasText: string("Required descendant text.", { maxLength: 2_000 }),
      hasNotText: string("Excluded descendant text.", { maxLength: 2_000 }),
      visible: boolean("Filter by current visibility."),
      has: locatorAtom,
      hasNot: locatorAtom,
    }),
    and: locatorAtom,
    or: locatorAtom,
    index: number("Zero-based locator match index.", { minimum: 0, maximum: 499 }),
    position: string("Locator endpoint after an explicit count.", { enum: ["first", "last"] }),
  }, ["strategy", "value"]);
  const locator = schema({
    ...simpleLocator.properties,
    frame: { type: "array", maxItems: 8, items: string("CSS iframe selector.", { minLength: 1, maxLength: 1_000 }) },
    scope: simpleLocator,
  }, ["strategy", "value"]);
  const baseTab = { tabId: string("Run-owned Rudder Browser tab id.", { minLength: 1, maxLength: 160 }) };

  switch (id) {
    case "browser.tabs":
    case "browser.user-tabs": return schema({});
    case "browser.open": return schema({ url: string("HTTP or HTTPS URL.", { minLength: 1, maxLength: 8_192 }) }, ["url"]);
    case "browser.navigate": return schema({ ...baseTab, url: string("HTTP or HTTPS URL.", { minLength: 1, maxLength: 8_192 }) }, ["tabId", "url"]);
    case "browser.back":
    case "browser.forward":
    case "browser.reload":
    case "browser.read":
    case "browser.close": return schema(baseTab, ["tabId"]);
    case "browser.viewport": return schema({
      action: string("Viewport action.", { enum: ["get", "set", "reset"] }),
      width: number("Viewport width in CSS pixels.", { minimum: 320, maximum: 3_840 }),
      height: number("Viewport height in CSS pixels.", { minimum: 240, maximum: 2_160 }),
    }, ["action"]);
    case "browser.visibility": return schema({ visible: boolean("Whether the selected Agent Browser tab is visible.") });
    case "browser.snapshot": return schema({
      ...baseTab,
      boxes: boolean("Include viewport-relative element boxes."),
      depth: number("Maximum snapshot tree depth.", { minimum: 1, maximum: 30 }),
      maxNodes: number("Maximum snapshot nodes.", { minimum: 1, maximum: 3_000 }),
    }, ["tabId"]);
    case "browser.locator": return schema({
      ...baseTab,
      action: string("Locator read or interaction action.", { enum: ["count", "allTextContents", "textContent", "innerText", "value", "attribute", "visible", "enabled", "checked", "selected", "click", "dblclick", "fill", "type", "press", "check", "uncheck", "setChecked", "select", "wait", "hover", "scroll", "drag", "setFiles"] }),
      locator,
      targetLocator: locator,
      name: string("Attribute name for attribute reads.", { maxLength: 200 }),
      value: string("Text value for fill or type.", { maxLength: 100_000 }),
      key: string("Keyboard key for press.", { maxLength: 100 }),
      checked: boolean("Target checked state."),
      values: { type: "array", maxItems: 100, items: { oneOf: [string("Option value or label.", { maxLength: 2_000 }), schema({ value: string("Option value."), label: string("Option label."), index: number("Option index.") })] } },
      paths: { type: "array", minItems: 1, maxItems: 10, items: string("Absolute path to a local upload file.", { minLength: 1, maxLength: 4_096 }) },
      button: string("Mouse button.", { enum: ["left", "right", "middle"] }),
      modifiers: { type: "array", maxItems: 5, items: string("Keyboard modifier.", { enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] }) },
      state: string("Wait state.", { enum: ["attached", "detached", "visible", "hidden"] }),
      timeoutMs: number("Wait timeout in milliseconds.", { minimum: 0, maximum: 30_000 }),
      x: number("Horizontal scroll delta."),
      y: number("Vertical scroll delta."),
      intoView: boolean("Scroll the locator into the viewport."),
      expectNavigation: schema({
        url: string("Expected URL substring.", { maxLength: 8_192 }),
        waitUntil: string("Requested load state.", { enum: ["commit", "domcontentloaded", "load", "networkidle"] }),
        timeoutMs: number("Navigation timeout in milliseconds.", { minimum: 100, maximum: 30_000 }),
      }),
      dialogResponse: schema({
        accept: boolean("Whether to accept the dialog opened by this action."),
        promptText: string("Prompt response text.", { maxLength: 10_000 }),
      }, ["accept"]),
    }, ["tabId", "action", "locator"]);
    case "browser.cua": return schema({
      ...baseTab,
      action: string("Coordinate input or inspection action.", { enum: ["click", "doubleClick", "move", "scroll", "drag", "keypress", "type", "elementInfo"] }),
      x: number("Viewport X coordinate."),
      y: number("Viewport Y coordinate."),
      scrollX: number("Horizontal scroll delta."),
      scrollY: number("Vertical scroll delta."),
      button: { oneOf: [number("Mouse button number.", { minimum: 1, maximum: 5 }), string("Mouse button.", { enum: ["left", "middle", "right"] })] },
      keys: { type: "array", maxItems: 10, items: string("Keyboard key or modifier.", { minLength: 1, maxLength: 100 }) },
      text: string("Text to type.", { maxLength: 100_000 }),
      path: { type: "array", minItems: 2, maxItems: 200, items: schema({ x: number("Path X coordinate."), y: number("Path Y coordinate.") }, ["x", "y"]) },
    }, ["tabId", "action"]);
    case "browser.dom-cua": return schema({
      ...baseTab,
      action: string("DOM input action.", { enum: ["get", "click", "doubleClick", "scroll", "keypress", "type"] }),
      nodeId: string("Node id from the latest DOM CUA snapshot.", { maxLength: 160 }),
      x: number("Horizontal scroll delta."),
      y: number("Vertical scroll delta."),
      keys: { type: "array", maxItems: 10, items: string("Keyboard key or modifier.", { minLength: 1, maxLength: 100 }) },
      text: string("Text to type.", { maxLength: 100_000 }),
      depth: number("Maximum DOM depth.", { minimum: 1, maximum: 30 }),
      maxNodes: number("Maximum DOM nodes.", { minimum: 1, maximum: 3_000 }),
    }, ["tabId", "action"]);
    case "browser.evaluate": return schema({
      ...baseTab,
      function: string("Read-only JavaScript function source.", { minLength: 1, maxLength: 50_000 }),
      locator,
      arg: { description: "JSON-serializable function argument." },
      timeoutMs: number("Evaluation timeout in milliseconds.", { minimum: 100, maximum: 30_000 }),
    }, ["tabId", "function"]);
    case "browser.dialog": return schema({
      ...baseTab,
      action: string("Dialog action.", { enum: ["get", "accept", "dismiss"] }),
      promptText: string("Prompt response text.", { maxLength: 10_000 }),
    }, ["tabId", "action"]);
    case "browser.clipboard": return schema({
      action: string("Virtual clipboard action.", { enum: ["read", "readText", "write", "writeText", "clear"] }),
      text: string("Plain clipboard text.", { maxLength: 500_000 }),
      items: {
        type: "array",
        maxItems: 20,
        items: schema({
          presentationStyle: string("Clipboard presentation style.", { enum: ["unspecified", "inline", "attachment"] }),
          entries: {
            type: "array",
            maxItems: 20,
            items: schema({
              mimeType: string("Clipboard MIME type.", { minLength: 1, maxLength: 200 }),
              text: string("Text clipboard payload.", { maxLength: 500_000 }),
              base64: string("Base64 clipboard payload.", { maxLength: 1_400_000 }),
            }, ["mimeType"]),
          },
        }, ["entries"]),
      },
    }, ["action"]);
    case "browser.logs": return schema({
      ...baseTab,
      levels: { type: "array", maxItems: 5, items: string("Log level.", { enum: ["debug", "info", "log", "warn", "error"] }) },
      filter: string("Case-insensitive log substring filter.", { maxLength: 2_000 }),
      limit: number("Maximum log entries.", { minimum: 1, maximum: 500 }),
      clear: boolean("Clear the tab log buffer after reading."),
    }, ["tabId"]);
    case "browser.download": return schema({
      ...baseTab,
      mode: string("Download mode.", { enum: ["media", "trigger"] }),
      locator,
      timeoutMs: number("Download timeout in milliseconds.", { minimum: 100, maximum: 60_000 }),
    }, ["tabId", "mode", "locator"]);
    case "browser.assets": return schema({
      ...baseTab,
      action: string("Asset action.", { enum: ["list", "bundle"] }),
      inventoryId: string("Prior asset inventory id.", { maxLength: 160 }),
      assetIds: { type: "array", minItems: 1, maxItems: 100, items: string("Asset id.", { maxLength: 160 }) },
      kinds: { type: "array", minItems: 1, maxItems: 4, items: string("Asset kind.", { enum: ["font", "image", "stylesheet", "video"] }) },
    }, ["tabId", "action"]);
    case "browser.content": return schema({
      ...baseTab,
      format: string("Content export format.", { enum: ["html", "text", "pdf", "md", "docx", "xlsx", "csv", "pptx"] }),
    }, ["tabId", "format"]);
    case "browser.wait": return schema({
      ...baseTab,
      url: string("URL substring.", { maxLength: 8_192 }),
      text: string("Text that must appear.", { maxLength: 10_000 }),
      textGone: string("Text that must disappear.", { maxLength: 10_000 }),
      timeMs: number("Fixed bounded delay in milliseconds.", { minimum: 0, maximum: 30_000 }),
      timeoutMs: number("Wait timeout in milliseconds.", { minimum: 0, maximum: 30_000 }),
    }, ["tabId"]);
    case "browser.click": return schema({ ...baseTab, ref: string("Element reference returned by rudder_browser_read.", { maxLength: 160 }) }, ["tabId", "ref"]);
    case "browser.type": return schema({
      ...baseTab,
      ref: string("Element reference returned by rudder_browser_read.", { maxLength: 160 }),
      text: string("Text to enter.", { maxLength: 100_000 }),
      submit: boolean("Submit the owning form after typing."),
    }, ["tabId", "ref", "text"]);
    case "browser.screenshot": return schema({
      ...baseTab,
      fullPage: boolean("Capture the full scrollable page."),
      format: string("Image format.", { enum: ["png", "jpeg"] }),
      quality: number("JPEG quality.", { minimum: 1, maximum: 100 }),
      clip: schema({ x: number("Clip X coordinate."), y: number("Clip Y coordinate."), width: number("Clip width.", { minimum: 1 }), height: number("Clip height.", { minimum: 1 }) }, ["x", "y", "width", "height"]),
      locator,
    }, ["tabId"]);
    default: return schema({});
  }
}

export function rudderMcpInputSchemaForCapability(id: string): {
  type: "object";
  additionalProperties: false;
  properties: Record<string, unknown>;
  required?: string[];
} {
  if (id.startsWith("browser.")) return browserMcpInputSchema(id);
  const properties: Record<string, unknown> = {};
  const add = (key: string, value: Record<string, unknown>) => {
    properties[key] = value;
  };

  if (id.startsWith("runs.")) {
    const addString = (key: string, description: string) => add(key, mcpString(description));
    const addNumber = (key: string, description: string) => add(key, mcpNumber(description));
    const addBoolean = (key: string, description: string) => add(key, mcpBoolean(description));
    switch (id) {
      case "runs.list":
        addString("updatedAfter", "Only runs updated after this timestamp.");
        addString("runIdPrefix", "Run id prefix filter.");
        addString("relatedAgentId", "Agent id filter.");
        addString("status", "Run status filter.");
        addString("runtime", "Runtime type filter.");
        addString("issueId", "Linked issue id filter.");
        addString("usedSkill", "Used skill filter.");
        addString("loadedSkill", "Loaded skill filter.");
        addString("createdBefore", "Only runs created before this timestamp.");
        addString("cursor", "Stable summary cursor.");
        addNumber("limit", "Summary page size, capped by the server.");
        break;
      case "runs.by-skill":
        addString("skill", "Skill key or display name.");
        addString("evidence", "Evidence type: used or loaded.");
        addString("relatedAgentId", "Agent id filter.");
        addString("status", "Run status filter.");
        addString("runtime", "Runtime type filter.");
        addString("issueId", "Linked issue id filter.");
        addString("createdBefore", "Only runs created before this timestamp.");
        addString("cursor", "Stable summary cursor.");
        addNumber("limit", "Summary page size, capped by the server.");
        break;
      case "runs.events":
        addString("run", "Run id or short run id.");
        addString("cursor", "Opaque total-order event cursor.");
        addNumber("afterSeq", "Legacy sequence-only cursor.");
        addNumber("limit", "Event page size, capped by the server.");
        addNumber("maxChars", "Maximum payload preview characters per event.");
        break;
      case "runs.log":
        addString("run", "Run id or short run id.");
        addNumber("maxChars", "Maximum log characters for display.");
        addNumber("offset", "Byte offset for the ranged read.");
        addNumber("limitBytes", "Maximum bytes for the ranged read.");
        break;
      case "runs.transcript":
        addString("run", "Run id or short run id.");
        addBoolean("errorsOnly", "Return only error rows.");
        addString("aroundError", "Transcript error step id.");
        addNumber("contextTurns", "Turns around the selected error.");
        addString("cursor", "Stable transcript cursor.");
        addNumber("turnLimit", "Maximum turns to return.");
        addBoolean("chronological", "Return oldest-first rows.");
        addBoolean("narrative", "Use narrative row formatting.");
        addNumber("maxChars", "Maximum output characters per row.");
        addBoolean("includeOutput", "Include clipped row output.");
        break;
      case "runs.errors":
        addString("run", "Run id or short run id.");
        addString("cursor", "Error page cursor.");
        addNumber("maxChars", "Maximum output characters per error.");
        break;
      default:
        addString("run", "Run id or short run id.");
        break;
    }
    return { type: "object", additionalProperties: false, properties };
  }

  if (id.startsWith("issue.")) {
    add("issue", mcpString("Issue UUID, identifier, or short reference."));
    add("body", mcpString("Direct Markdown body for issue comments or close-out notes."));
    add("comment", mcpString("Direct Markdown review, blocker, or completion comment."));
    add("images", { type: "array", items: { type: "string" }, description: "Local image paths to attach when supported." });
  }
  if (id.startsWith("project.")) add("project", mcpString("Project UUID or shortname."));
  if (id.startsWith("library.file.")) {
    add("path", mcpString("Library-relative file or directory path."));
    if (id === "library.file.list") {
      add("directory", mcpString("Library-relative directory path. Defaults to the run's project Library path when available."));
    }
    add("body", mcpString("Direct file content for put operations."));
  }
  if (id.startsWith("approval.")) {
    add("approval", mcpString("Approval UUID or short reference."));
    add("body", mcpString("Direct Markdown approval comment body."));
  }
  if (id.startsWith("skill.")) {
    add("skill", mcpString("Organization skill id."));
    add("path", mcpString("Skill package file path, such as SKILL.md."));
  }
  if (id.startsWith("browser.")) {
    add("url", mcpString("HTTP or HTTPS URL."));
    add("tabId", mcpString("Run-owned Rudder Browser tab id."));
    add("ref", mcpString("Element reference returned by rudder_browser_read."));
    add("text", mcpString("Text to enter into the referenced element."));
  }
  if (id.startsWith("automation.")) {
    add("automation", mcpString("Automation id."));
    add("trigger", mcpString("Automation trigger id."));
    add("payload", { type: ["object", "string"], description: "JSON payload object or JSON string." });
  }
  if (id.startsWith("chat.")) {
    add("chat", mcpString("Chat conversation id."));
    add("body", mcpString("Agent-authored chat message body."));
  }
  if (id.startsWith("agent.skills.")) {
    add("selectionRefs", { type: "array", items: { type: "string" }, description: "Skill selection refs." });
    add("skills", { type: "array", items: { type: "string" }, description: "Skill selection refs alias." });
    add("desiredSkills", mcpString("Comma-separated desired skill refs for sync."));
  }

  for (const [key, description] of Object.entries({
    query: "Search query.",
    decision: "Structured review decision.",
    title: "Title.",
    name: "Name.",
    description: "Description or summary text.",
    status: "Status filter or new status.",
    cursor: "Pagination cursor.",
    source: "Source path or source label.",
    kind: "Trigger kind.",
    label: "Trigger label.",
    skill: "Skill key, id, or display name.",
    slug: "Slug.",
    markdown: "Direct Markdown content.",
    role: "Agent role.",
    reportsTo: "Manager or reporting agent reference.",
    capabilities: "Agent capability summary.",
    wakeCommentId: "Issue comment id that triggered the wake.",
    expectedStatuses: "Comma-separated checkout precondition statuses.",
    after: "Pagination anchor or lower bound.",
    order: "Sort order.",
    priority: "Issue or automation priority.",
    assigneeAgentId: "Target assignee agent id or reference.",
    projectId: "Project id or reference.",
    goalId: "Goal id or reference.",
    parentId: "Parent issue id or reference.",
    parentIssueId: "Parent issue id or reference.",
    requestDepth: "Requested issue depth.",
    billingCode: "Billing code.",
    hiddenAt: "Hidden timestamp.",
    archivedAt: "Archived timestamp.",
    targetDate: "Target date.",
    color: "Display color.",
    scope: "Search or visibility scope.",
    sha: "Git commit SHA.",
    message: "Commit or status message.",
    branch: "Git branch name.",
    repoPath: "Repository path.",
    workspacePath: "Workspace path.",
    relatedAgentId: "Agent id used as a filter or related principal.",
    leadAgentId: "Lead agent id or reference.",
    approvalId: "Approval id or short approval id alias.",
    automationId: "Automation id alias.",
    chatId: "Chat conversation id alias.",
    commentId: "Issue comment id alias.",
    skillId: "Skill id alias.",
    user: "User id, reference, or self.",
    since: "Activity start timestamp.",
    until: "Activity end timestamp.",
    include: "Comma-separated optional data sections.",
    content: "Direct content alias for body.",
    roots: "Comma-separated local roots.",
    projectIds: "Comma-separated project ids.",
    workspaceIds: "Comma-separated workspace ids.",
    cronExpression: "Cron expression.",
    timezone: "Timezone.",
    signingMode: "Webhook signing mode.",
    replayWindowSec: "Webhook replay window in seconds.",
    instructions: "Automation instructions.",
    outputMode: "Automation output mode.",
    concurrencyPolicy: "Automation concurrency policy.",
    catchUpPolicy: "Automation catch-up policy.",
    triggerId: "Automation trigger id.",
    idempotencyKey: "Idempotency key.",
    summary: "Chat summary.",
    preferredAgentId: "Preferred responding agent id or reference.",
    issueCreationMode: "Chat issue creation mode.",
    editUserMessageId: "User message id to edit.",
    updatedAfter: "Run updated-after timestamp.",
    runIdPrefix: "Run id prefix filter.",
    runtime: "Runtime type filter.",
    issueId: "Issue id filter.",
    usedSkill: "Used skill filter.",
    loadedSkill: "Loaded skill filter.",
    createdBefore: "Created-before timestamp.",
    evidence: "Skill evidence type.",
    aroundError: "Transcript error step id.",
    maxOutputChars: "Maximum output characters.",
  })) {
    add(key, mcpString(description));
  }
  for (const [key, description] of Object.entries({
    limit: "Page size or result limit.",
    count: "Count represented by a report.",
    turnLimit: "Maximum turns to return.",
    contextTurns: "Number of context turns.",
    maxChars: "Maximum characters.",
    snippetChars: "Maximum snippet characters.",
    afterSeq: "Return events after this sequence number.",
    offset: "Byte offset for ranged reads.",
    limitBytes: "Maximum bytes for ranged reads.",
  })) {
    add(key, mcpNumber(description));
  }
  for (const [key, description] of Object.entries({
    selectionRefs: "Skill selection refs.",
    selections: "Skill selection refs alias.",
    skills: "Skill selection refs alias.",
    images: "Local image paths to attach when supported.",
    goalIds: "Goal ids.",
  })) {
    add(key, mcpStringArray(description));
  }
  for (const key of ["clearTitle", "clearCapabilities", "clearDescription", "clearReportsTo", "enable", "enabled", "disabled", "reopen", "planMode", "includeTranscript", "includeOutput", "includeOutputs", "notifyOnIssueCreated", "errorsOnly", "chronological", "narrative", "submit", "full"]) {
    add(key, mcpBoolean(`Boolean option ${key}.`));
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(id === "chat.create" ? { required: ["body"] } : {}),
  };
}

export const RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS = RUDDER_MCP_TOOL_DESCRIPTORS.map((tool) => ({
  ...tool,
  inputSchema: rudderMcpInputSchemaForCapability(tool.capabilityId),
}));

export function rudderMcpSemanticToolContract(
  tool: RudderMcpToolContractSource,
): RudderMcpSemanticToolContract {
  return {
    name: tool.name,
    description: `${tool.description} Mutating: ${tool.mutating ? "yes" : "no"}. Runtime identity and authorization are injected by the Rudder-managed MCP server and are not accepted as tool input. Org context: ${tool.requiresOrgId ? "required from runtime env" : "not required by this tool"}. Agent context: ${tool.requiresAgentId ? "required from runtime env" : "runtime env when available"}. Run attribution: ${tool.attachesRunIdWhenAvailable ? "attached from runtime env when available" : "not attached"}.`,
    inputSchema: tool.inputSchema,
  };
}

export const RUDDER_MCP_CANONICAL_TOOL_CONTRACTS = RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS
  .map(rudderMcpSemanticToolContract);

export const RUDDER_CORE_MCP_TOOL_CONTRACTS = RUDDER_MCP_CANONICAL_TOOL_CONTRACTS
  .filter((tool) => !tool.name.startsWith("rudder_browser_"));
export const RUDDER_BROWSER_MCP_TOOL_CONTRACTS = RUDDER_MCP_CANONICAL_TOOL_CONTRACTS
  .filter((tool) => tool.name.startsWith("rudder_browser_"));

export const RUDDER_CORE_MCP_TOOL_NAMES = RUDDER_CORE_MCP_TOOL_CONTRACTS.map((tool) => tool.name);
export const RUDDER_BROWSER_MCP_TOOL_NAMES = RUDDER_BROWSER_MCP_TOOL_CONTRACTS.map((tool) => tool.name);

export const RUDDER_CORE_MCP_CONTRACT_HASH = GENERATED_RUDDER_CORE_MCP_CONTRACT_HASH;
export const RUDDER_BROWSER_MCP_CONTRACT_HASH = GENERATED_RUDDER_BROWSER_MCP_CONTRACT_HASH;
