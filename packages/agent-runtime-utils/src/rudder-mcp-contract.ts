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
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface RudderMcpToolContractSource extends RudderMcpSemanticToolContract {
  capabilityId: string;
  mutating: boolean;
  requiresOrgId: boolean;
  requiresAgentId: boolean;
  attachesRunIdWhenAvailable: boolean;
}

interface RudderMcpInputSchema extends Record<string, unknown> {
  type: "object";
  additionalProperties: false;
  properties: Record<string, unknown>;
  required?: string[];
  anyOf?: Array<{ required: string[] }>;
}

const RUDDER_MCP_DESTRUCTIVE_CAPABILITY_IDS = new Set([
  "agent.skills.sync",
  "issue.block",
  "issue.done",
  "library.file.put",
  "automation.triggers.delete",
  "automation.triggers.rotate-secret",
  "automation.disable",
  "chat.archive",
  "runs.cancel",
  "browser.clipboard",
  "browser.logs",
]);

const RUDDER_MCP_OPEN_WORLD_CAPABILITY_IDS = new Set([
  "browser.open",
  "browser.navigate",
  "browser.download",
  "browser.content",
]);

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
      action: string("Read-only locator action.", { enum: ["count", "allTextContents", "textContent", "innerText", "attribute", "visible", "enabled", "checked", "selected", "wait"] }),
      locator,
      name: string("Attribute name for attribute reads.", { maxLength: 200 }),
      state: string("Wait state.", { enum: ["attached", "detached", "visible", "hidden"] }),
      timeoutMs: number("Wait timeout in milliseconds.", { minimum: 0, maximum: 30_000 }),
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
      action: string("Read-only DOM snapshot action.", { enum: ["get"] }),
      depth: number("Maximum DOM depth.", { minimum: 1, maximum: 30 }),
      maxNodes: number("Maximum DOM nodes.", { minimum: 1, maximum: 3_000 }),
    }, ["tabId", "action"]);
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
              base64: string("Base64 clipboard payload.", { maxLength: 650_000 }),
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
      mode: string("Read-only media download mode.", { enum: ["media"] }),
      locator,
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
      format: string("Content export format.", { enum: ["text", "pdf", "md", "docx", "xlsx", "csv", "pptx"] }),
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

export function rudderMcpInputSchemaForCapability(id: string): RudderMcpInputSchema {
  if (id.startsWith("browser.")) return browserMcpInputSchema(id);
  return coreMcpInputSchema(id);
}

function coreMcpInputSchema(id: string): RudderMcpInputSchema {
  const string = (description: string, extra: Record<string, unknown> = {}) => ({
    type: "string",
    description,
    minLength: 1,
    maxLength: 100_000,
    ...extra,
  });
  const number = (description: string, minimum = 0, maximum = 10_000) => ({
    type: "number",
    description,
    minimum,
    maximum,
  });
  const boolean = (description: string) => ({ type: "boolean", description });
  const strings = (description: string, maxItems = 100) => ({
    type: "array",
    description,
    maxItems,
    items: string(description, { maxLength: 8_192 }),
  });
  const payload = { type: ["object", "string"], description: "JSON payload object or JSON string." };
  const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object" as const,
    additionalProperties: false as const,
    properties,
    ...(required.length > 0 ? { required } : {}),
  });

  const issue = string("Issue UUID, identifier, or short reference.", { maxLength: 200 });
  const goal = string("Goal UUID or typed short reference (gol_<prefix>) from the current Goal Runtime Context.", { maxLength: 200 });
  const project = string("Project UUID or shortname.", { maxLength: 200 });
  const approval = string("Approval UUID or short reference.", { maxLength: 200 });
  const automation = string("Automation UUID or short reference.", { maxLength: 200 });
  const trigger = string("Automation trigger UUID or short reference.", { maxLength: 200 });
  const chat = string("Chat conversation UUID or short reference.", { maxLength: 200 });
  const run = string("Run UUID, typed short reference (run_<prefix>), or legacy bare short prefix.", { maxLength: 200 });
  const cursor = string("Opaque pagination cursor.", { maxLength: 2_000 });
  const body = string("Direct Markdown body.", { maxLength: 500_000 });
  const images = strings("Local image paths to attach.", 20);

  switch (id) {
    case "agent.me":
    case "agent.inbox":
    case "agent.capabilities":
    case "project.list":
    case "skill.list":
      return schema({});
    case "skill.search":
      return schema({
        query: string("Skill name, slug, description, source, or selection key to search for.", { maxLength: 2_000 }),
      }, ["query"]);
    case "plugin.search":
      return schema({
        query: string("Plugin name, description, publisher, source, or component to search for.", { maxLength: 2_000 }),
      }, ["query"]);
    case "plugin.get":
      return schema({
        plugin: string("Installed plugin UUID from a plugin:// reference or plugin search result.", { maxLength: 200 }),
      }, ["plugin"]);
    case "organization.members.list":
      return schema({
        query: string("Optional member name filter.", { maxLength: 2_000 }),
        type: string("Member type filter.", { enum: ["human", "agent", "all"], maxLength: 10 }),
        limit: number("Page size.", 1, 100),
        cursor,
      });
    case "agent.update":
      return schema({
        name: string("Agent name.", { maxLength: 200 }),
        role: string("Agent role.", { maxLength: 100 }),
        title: string("Agent title.", { maxLength: 300 }),
        capabilities: string("Agent capability summary."),
        description: string("Compatibility alias for capabilities."),
        clearTitle: boolean("Clear the current title."),
        clearCapabilities: boolean("Clear the current capability summary."),
        clearDescription: boolean("Compatibility alias for clearCapabilities."),
      });
    case "agent.skills.create":
      return schema({
        name: string("Skill display name.", { maxLength: 200 }),
        slug: string("Skill slug.", { maxLength: 200 }),
        description: string("Skill description."),
        markdown: string("SKILL.md content.", { maxLength: 500_000 }),
        body: string("Compatibility alias for markdown.", { maxLength: 500_000 }),
        enable: boolean("Enable the created skill for the runtime agent."),
      }, ["name"]);
    case "agent.skills.enable":
      return schema({ selectionRefs: strings("Skill selection references.", 100) }, ["selectionRefs"]);
    case "agent.skills.sync":
      return schema({ desiredSkills: string("Comma-separated desired skill references.", { maxLength: 20_000 }) }, ["desiredSkills"]);
    case "goal.list":
      return schema({
        lifecycle: string("Goal lifecycle filter; active is the safe default.", {
          enum: ["draft", "active", "closed", "all"],
          maxLength: 20,
        }),
        focus: boolean("Filter by whether the Goal is the organization Focus Goal."),
        facet: string("Current Goal workspace facet.", {
          enum: ["agent_advancing", "needs_attention", "waiting_focus", "waiting_external", "ready_for_acceptance", "closed"],
          maxLength: 40,
        }),
        limit: number("Maximum owned Goals to return.", 1, 100),
      });
    case "goal.context":
      return schema({ goal: string("Goal UUID returned by rudder_goal_list.", { maxLength: 200 }) }, ["goal"]);
    case "goal.progress":
      return schema({
        goal,
        summary: string("Plain-language progress, observed change, or named blocker."),
        activityKind: string("Progress classification.", { enum: ["progress", "evidence", "bottleneck"], maxLength: 30 }),
        evidenceRefs: {
          type: "array",
          description: "URI-like references to artifacts, measurements, or other supporting evidence.",
          minItems: 1,
          maxItems: 100,
          items: string("URI-like evidence reference.", { maxLength: 8_192 }),
        },
        idempotencyKey: string("Stable key for safe retry.", { maxLength: 500 }),
      }, ["goal", "summary", "evidenceRefs", "idempotencyKey"]);
    case "goal.checkpoint":
      return schema({
        goal,
        summary: string("Plain-language bounded-run checkpoint summary."),
        evidenceRefs: {
          type: "array",
          description: "URI-like references to artifacts, measurements, or other supporting evidence.",
          maxItems: 100,
          items: string("URI-like evidence reference.", { maxLength: 8_192 }),
        },
        expectedPlanRevision: number("Plan revision read before this checkpoint.", 1, 1_000_000_000),
        plan: {
          type: "object",
          description: "Optional complete next Plan revision; omit when the current Plan remains valid.",
          additionalProperties: false,
          properties: {
            summary: string("Plan summary."),
            hypotheses: { type: "array", maxItems: 1000, items: {} },
            selectedPaths: { type: "array", maxItems: 1000, items: {} },
            rejectedPaths: { type: "array", maxItems: 1000, items: {} },
            sequencing: { type: "array", maxItems: 1000, items: {} },
            budgetAllocations: { type: "object", additionalProperties: true },
            invalidationConditions: { type: "array", maxItems: 1000, items: {} },
          },
          required: ["summary"],
        },
        continuation: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: string("Continuation policy.", { enum: ["commitment", "wait", "decision", "verification"] }),
            summary: string("What should happen next or what is awaited."),
            wakeCondition: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          },
          required: ["kind", "summary"],
        },
        idempotencyKey: string("Stable key for safe retry.", { maxLength: 500 }),
      }, ["goal", "summary", "evidenceRefs", "expectedPlanRevision", "continuation", "idempotencyKey"]);
    case "goal.change.propose":
      return schema({
        goal,
        contractRevision: number("Current Goal contract revision.", 1, 1_000_000_000),
        afterContract: {
          type: "object",
          description: "Only the Goal contract fields that should change.",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            outcomeStatement: string("Proposed result-oriented outcome."),
            objectiveMode: string("Proposed objective mode.", {
              enum: ["target", "maximize", "maintain", "decide"],
              maxLength: 20,
            }),
            criteria: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: schema({
                id: string("Stable criterion id.", { maxLength: 500 }),
                label: string("Plain-language success criterion."),
                evaluator: string("Criterion evaluator.", {
                  enum: ["artifact", "metric", "policy", "human"],
                  maxLength: 20,
                }),
                evidenceRequirements: {
                  type: "array",
                  maxItems: 100,
                  items: string("URI-like required evidence reference.", { maxLength: 8_192 }),
                },
              }, ["id", "label", "evaluator"]),
            },
            autonomyEnvelope: { type: "object", additionalProperties: true },
            humanAuthorities: { type: "object", additionalProperties: true },
            evaluationPolicy: { type: "object", additionalProperties: true },
            actionDeadline: {
              description: "Proposed ISO-8601 action deadline, or null to clear it.",
              oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
            },
            evaluationDeadline: {
              description: "Proposed ISO-8601 evaluation deadline, or null to clear it.",
              oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
            },
          },
        },
        rationale: string("Why the current contract should change and what evidence invalidated it."),
        evidenceRefs: {
          type: "array",
          description: "URI-like references supporting the proposed change.",
          maxItems: 100,
          items: string("URI-like evidence reference.", { maxLength: 8_192 }),
        },
        idempotencyKey: string("Stable key for safe retry.", { maxLength: 500 }),
      }, ["goal", "contractRevision", "afterContract", "rationale", "idempotencyKey"]);
    case "goal.result.propose":
      return schema({
        goal,
        contractRevision: number("Current Goal contract revision.", 1, 1_000_000_000),
        criteria: {
          type: "array",
          description: "Criterion outcomes for the current contract revision.",
          minItems: 1,
          maxItems: 100,
          items: schema({
            id: string("Criterion id from the Goal Runtime Context.", { maxLength: 500 }),
            status: string("Observed criterion status.", { enum: ["met", "unmet", "breached", "unknown"], maxLength: 20 }),
          }, ["id", "status"]),
        },
        evidenceRefs: {
          type: "array",
          description: "URI-like references supporting the proposed result.",
          minItems: 1,
          maxItems: 100,
          items: string("URI-like evidence reference.", { maxLength: 8_192 }),
        },
        resultValue: {
          description: "Optional measured result value.",
          oneOf: [{ type: "string", maxLength: 100_000 }, { type: "number" }, { type: "boolean" }],
        },
        decision: string("Optional decision reached for decide-mode Goals."),
        resultPayload: { type: "object", description: "Optional structured result details.", additionalProperties: true },
        riskSummary: string("Known risks, limitations, or remaining gaps."),
        idempotencyKey: string("Stable key for safe retry.", { maxLength: 500 }),
      }, ["goal", "contractRevision", "criteria", "evidenceRefs", "riskSummary", "idempotencyKey"]);
    case "issue.create":
      return schema({
        title: string("Issue title.", { maxLength: 500 }),
        description: string("Issue description.", { maxLength: 500_000 }),
        status: string("Issue status.", { maxLength: 100 }),
        priority: string("Issue priority.", { maxLength: 100 }),
        assigneeAgentId: string("Assignee agent id or reference.", { maxLength: 200 }),
        projectId: string("Project id or reference.", { maxLength: 200 }),
        goalId: string("Goal id or reference.", { maxLength: 200 }),
        parentId: string("Parent issue id or reference.", { maxLength: 200 }),
        requestDepth: number("Requested issue depth.", 0, 10_000),
        billingCode: string("Billing code.", { maxLength: 200 }),
        labelIds: strings("Issue label ids.", 100),
      }, ["title"]);
    case "issue.list":
      return schema({
        status: string("Comma-separated issue statuses.", { maxLength: 500 }),
        assigneeAgentId: string("Assignee agent id or reference.", { maxLength: 200 }),
        projectId: string("Project id or reference.", { maxLength: 200 }),
      });
    case "issue.get":
      return schema({ issue }, ["issue"]);
    case "issue.search":
      return schema({
        query: string("Non-empty server-side issue search query.", { maxLength: 2_000 }),
        status: string("Comma-separated issue statuses.", { maxLength: 500 }),
        assigneeAgentId: string("Assignee agent id or reference.", { maxLength: 200 }),
        projectId: string("Project id or reference.", { maxLength: 200 }),
      }, ["query"]);
    case "issue.context":
      return schema({ issue, wakeCommentId: string("Wake comment id or short reference.", { maxLength: 200 }) }, ["issue"]);
    case "issue.checkout":
      return schema({ issue, expectedStatuses: string("Comma-separated allowed prior statuses.", { maxLength: 500 }) }, ["issue"]);
    case "issue.comment":
      return {
        ...schema({ issue, body, comment: body, images, reopen: boolean("Reopen the issue while commenting.") }, ["issue"]),
        anyOf: [{ required: ["body"] }, { required: ["comment"] }],
      };
    case "issue.comments.list":
      return schema({
        issue,
        after: string("Return comments after this comment id or short reference.", { maxLength: 200 }),
        order: string("Comment order.", { enum: ["asc", "desc"], maxLength: 10 }),
      }, ["issue"]);
    case "issue.comments.get":
      return schema({ issue, comment: string("Comment id or short reference.", { maxLength: 200 }) }, ["issue", "comment"]);
    case "issue.update":
      return schema({
        issue,
        title: string("Issue title.", { maxLength: 500 }),
        description: string("Issue description.", { maxLength: 500_000 }),
        status: string("New issue status.", { maxLength: 100 }),
        priority: string("New issue priority.", { maxLength: 100 }),
        assigneeAgentId: string("Assignee agent id or reference.", { maxLength: 200 }),
        projectId: string("Project id or reference.", { maxLength: 200 }),
        goalId: string("Goal id or reference.", { maxLength: 200 }),
        parentId: string("Parent issue id or reference.", { maxLength: 200 }),
        requestDepth: string("Requested issue depth.", { maxLength: 30 }),
        billingCode: string("Billing code.", { maxLength: 200 }),
        hiddenAt: string("Hidden timestamp.", { maxLength: 100 }),
        comment: body,
        body,
        images,
      }, ["issue"]);
    case "issue.review":
      return {
        ...schema({
          issue,
          decision: string("Structured review decision.", { enum: ["approve", "request_changes", "needs_followup", "blocked"], maxLength: 30 }),
          comment: body,
          body,
        }, ["issue", "decision"]),
        anyOf: [{ required: ["comment"] }, { required: ["body"] }],
      };
    case "issue.commit":
      return schema({
        issue,
        sha: string("Git commit SHA.", { maxLength: 100 }),
        message: string("Commit subject or status message.", { maxLength: 2_000 }),
        branch: string("Git branch name.", { maxLength: 500 }),
        repoPath: string("Repository path.", { maxLength: 8_192 }),
        workspacePath: string("Workspace path.", { maxLength: 8_192 }),
        count: number("Number of commits represented.", 1, 10_000),
      }, ["issue", "sha", "message"]);
    case "issue.done":
    case "issue.block":
      return {
        ...schema({ issue, comment: body, body, images }, ["issue"]),
        anyOf: [{ required: ["comment"] }, { required: ["body"] }],
      };
    case "project.get":
      return schema({ project }, ["project"]);
    case "project.create":
      return schema({
        name: string("Project name.", { maxLength: 300 }),
        description: string("Project description.", { maxLength: 500_000 }),
        status: string("Project status.", { maxLength: 100 }),
        goalId: string("Goal id or reference.", { maxLength: 200 }),
        goalIds: strings("Goal ids.", 100),
        leadAgentId: string("Lead agent id or reference.", { maxLength: 200 }),
        targetDate: string("Target date.", { maxLength: 100 }),
        color: string("Display color.", { maxLength: 100 }),
      }, ["name"]);
    case "project.update":
      return schema({
        project,
        name: string("Project name.", { maxLength: 300 }),
        description: string("Project description.", { maxLength: 500_000 }),
        status: string("Project status.", { maxLength: 100 }),
        goalId: string("Goal id or reference.", { maxLength: 200 }),
        goalIds: strings("Goal ids.", 100),
        leadAgentId: string("Lead agent id or reference.", { maxLength: 200 }),
        targetDate: string("Target date.", { maxLength: 100 }),
        color: string("Display color.", { maxLength: 100 }),
        archivedAt: string("Archive timestamp.", { maxLength: 100 }),
      }, ["project"]);
    case "user.activity":
      return schema({
        user: string("User id, reference, or self.", { maxLength: 200 }),
        since: string("Activity start timestamp.", { maxLength: 100 }),
        until: string("Activity end timestamp.", { maxLength: 100 }),
        include: string("Comma-separated optional sections.", { maxLength: 500 }),
        relatedAgentId: string("Related agent id.", { maxLength: 200 }),
        projectId: string("Project id.", { maxLength: 200 }),
        issueId: string("Issue id.", { maxLength: 200 }),
        limit: number("Page size.", 1, 100),
        cursor,
      });
    case "library.file.list":
      return schema({
        directory: string("Library-relative directory path.", { maxLength: 8_192 }),
        path: string("Compatibility alias for directory.", { maxLength: 8_192 }),
      });
    case "library.file.get":
    case "library.file.ref":
    case "library.file.link":
      return schema({ path: string("Library-relative file path.", { maxLength: 8_192 }) }, ["path"]);
    case "library.file.put":
      return {
        ...schema({
          path: string("Library-relative file path.", { maxLength: 8_192 }),
          body: string("Direct file content.", { maxLength: 1_000_000 }),
          content: string("Compatibility alias for body.", { maxLength: 1_000_000 }),
        }, ["path"]),
        anyOf: [{ required: ["body"] }, { required: ["content"] }],
      };
    case "approval.get":
    case "approval.issues":
      return schema({ approval }, ["approval"]);
    case "approval.comment":
      return {
        ...schema({ approval, body, comment: body }, ["approval"]),
        anyOf: [{ required: ["body"] }, { required: ["comment"] }],
      };
    case "skill.get":
      return schema({ skill: string("Organization skill id.", { maxLength: 200 }) }, ["skill"]);
    case "skill.file":
      return schema({
        skill: string("Organization skill id.", { maxLength: 200 }),
        path: string("Skill package file path.", { maxLength: 8_192 }),
      }, ["skill"]);
    case "skill.import":
      return schema({ source: string("Local path, URL, or repository reference.", { maxLength: 8_192 }) }, ["source"]);
    case "skill.scan-local":
      return schema({ roots: string("Comma-separated local roots.", { maxLength: 20_000 }) });
    case "skill.scan-projects":
      return schema({
        projectIds: string("Comma-separated project ids.", { maxLength: 20_000 }),
        workspaceIds: string("Comma-separated workspace ids.", { maxLength: 20_000 }),
      });
    case "automation.list":
      return schema({
        status: string("Automation status filter.", { maxLength: 100 }),
        assigneeAgentId: string("Assignee agent id.", { maxLength: 200 }),
        projectId: string("Project id.", { maxLength: 200 }),
        outputMode: string("Output mode filter.", { maxLength: 100 }),
      });
    case "automation.get":
    case "automation.triggers.list":
    case "automation.enable":
    case "automation.disable":
      return schema({ automation }, ["automation"]);
    case "automation.runs":
      return schema({ automation, limit: number("Maximum run rows.", 1, 100) }, ["automation"]);
    case "automation.triggers.create":
      return schema({
        automation,
        payload,
        kind: string("Trigger kind.", { maxLength: 100 }),
        label: string("Trigger label.", { maxLength: 300 }),
        enabled: boolean("Create the trigger enabled."),
        disabled: boolean("Create the trigger disabled."),
        cronExpression: string("Cron expression.", { maxLength: 500 }),
        timezone: string("IANA timezone.", { maxLength: 200 }),
        signingMode: string("Webhook signing mode.", { maxLength: 100 }),
        replayWindowSec: string("Webhook replay window in seconds.", { maxLength: 30 }),
      }, ["automation"]);
    case "automation.triggers.update":
      return schema({
        trigger,
        payload,
        label: string("Trigger label.", { maxLength: 300 }),
        enabled: boolean("Enable the trigger."),
        disabled: boolean("Disable the trigger."),
        cronExpression: string("Cron expression.", { maxLength: 500 }),
        timezone: string("IANA timezone.", { maxLength: 200 }),
        signingMode: string("Webhook signing mode.", { maxLength: 100 }),
        replayWindowSec: string("Webhook replay window in seconds.", { maxLength: 30 }),
      }, ["trigger"]);
    case "automation.triggers.delete":
    case "automation.triggers.rotate-secret":
      return schema({ trigger }, ["trigger"]);
    case "automation.create":
      return schema({
        payload,
        title: string("Automation title.", { maxLength: 500 }),
        instructions: string("Automation instructions.", { maxLength: 500_000 }),
        description: string("Compatibility alias for instructions.", { maxLength: 500_000 }),
        assigneeAgentId: string("Assignee agent id.", { maxLength: 200 }),
        projectId: string("Project id.", { maxLength: 200 }),
        goalId: string("Goal id.", { maxLength: 200 }),
        parentIssueId: string("Parent issue id.", { maxLength: 200 }),
        priority: string("Issue priority.", { maxLength: 100 }),
        status: string("Automation status.", { maxLength: 100 }),
        outputMode: string("Automation output mode.", { maxLength: 100 }),
        concurrencyPolicy: string("Concurrency policy.", { maxLength: 100 }),
        catchUpPolicy: string("Catch-up policy.", { maxLength: 100 }),
        notifyOnIssueCreated: boolean("Notify when an issue is created."),
      });
    case "automation.update":
      return schema({
        automation,
        payload,
        title: string("Automation title.", { maxLength: 500 }),
        instructions: string("Automation instructions.", { maxLength: 500_000 }),
        description: string("Compatibility alias for instructions.", { maxLength: 500_000 }),
        assigneeAgentId: string("Assignee agent id.", { maxLength: 200 }),
        projectId: string("Project id.", { maxLength: 200 }),
        goalId: string("Goal id.", { maxLength: 200 }),
        parentIssueId: string("Parent issue id.", { maxLength: 200 }),
        priority: string("Issue priority.", { maxLength: 100 }),
        status: string("Automation status.", { maxLength: 100 }),
        outputMode: string("Automation output mode.", { maxLength: 100 }),
        concurrencyPolicy: string("Concurrency policy.", { maxLength: 100 }),
        catchUpPolicy: string("Catch-up policy.", { maxLength: 100 }),
        notifyOnIssueCreated: boolean("Notify when an issue is created."),
      }, ["automation"]);
    case "automation.run":
      return schema({
        automation,
        triggerId: string("Trigger id.", { maxLength: 200 }),
        payload,
        idempotencyKey: string("Idempotency key.", { maxLength: 500 }),
        source: string("Invocation source.", { maxLength: 500 }),
      }, ["automation"]);
    case "chat.list":
      return schema({
        status: string("Chat status filter.", { maxLength: 100 }),
        query: string("Optional chat query.", { maxLength: 2_000 }),
        limit: number("Maximum chat rows.", 1, 100),
      });
    case "chat.search":
      return schema({
        query: string("Non-empty chat search query.", { maxLength: 2_000 }),
        status: string("Chat status filter.", { maxLength: 100 }),
        scope: string("Search scope.", { maxLength: 100 }),
        limit: number("Maximum matches.", 1, 100),
        snippetChars: number("Maximum snippet characters.", 100, 10_000),
      }, ["query"]);
    case "chat.get":
    case "chat.archive":
      return schema({ chat }, ["chat"]);
    case "chat.messages":
      return schema({
        chat,
        limit: number("Maximum message rows.", 1, 100),
        cursor,
        maxOutputChars: number("Maximum output characters per row.", 100, 20_000),
        includeTranscript: boolean("Include bounded transcript data."),
        includeOutput: boolean("Compatibility alias for includeTranscript."),
      }, ["chat"]);
    case "chat.transcript":
      return schema({
        chat,
        limit: number("Maximum transcript rows.", 1, 100),
        cursor,
        maxOutputChars: number("Maximum output characters per row.", 100, 20_000),
      }, ["chat"]);
    case "chat.read":
      return schema({
        chat,
        limit: number("Maximum message rows.", 1, 100),
        turnLimit: number("Maximum transcript turns.", 1, 100),
        cursor,
        maxOutputChars: number("Maximum output characters per row.", 100, 20_000),
        includeTranscript: boolean("Include bounded transcript data."),
        includeOutput: boolean("Compatibility alias for includeTranscript."),
      }, ["chat"]);
    case "chat.create":
      return schema({
        body: string("Initial agent-authored chat message.", { maxLength: 500_000 }),
        payload,
        title: string("Chat title.", { maxLength: 500 }),
        summary: string("Chat summary.", { maxLength: 10_000 }),
        preferredAgentId: string("Preferred responding agent id.", { maxLength: 200 }),
        issueCreationMode: string("Issue creation mode.", { maxLength: 100 }),
        planMode: boolean("Start the chat in plan mode."),
      }, ["body"]);
    case "chat.send":
      return schema({
        chat,
        body: string("Agent-authored chat message.", { maxLength: 500_000 }),
        editUserMessageId: string("User message id to edit.", { maxLength: 200 }),
      }, ["chat", "body"]);
    case "runs.list":
      return schema({
        updatedAfter: string("Only runs updated after this timestamp.", { maxLength: 100 }),
        runIdPrefix: string("Run id prefix filter.", { maxLength: 200 }),
        relatedAgentId: string("Agent id filter.", { maxLength: 200 }),
        status: string("Run status filter.", { maxLength: 100 }),
        runtime: string("Runtime type filter.", { maxLength: 100 }),
        issueId: string("Linked issue id filter.", { maxLength: 200 }),
        usedSkill: string("Used skill filter.", { maxLength: 500 }),
        loadedSkill: string("Loaded skill filter.", { maxLength: 500 }),
        createdBefore: string("Only runs created before this timestamp.", { maxLength: 100 }),
        cursor,
        limit: number("Summary page size.", 1, 100),
      });
    case "runs.by-skill":
      return schema({
        skill: string("Skill key or display name.", { maxLength: 500 }),
        evidence: string("Skill evidence type.", { enum: ["used", "loaded"], maxLength: 20 }),
        relatedAgentId: string("Agent id filter.", { maxLength: 200 }),
        status: string("Run status filter.", { maxLength: 100 }),
        runtime: string("Runtime type filter.", { maxLength: 100 }),
        issueId: string("Linked issue id filter.", { maxLength: 200 }),
        createdBefore: string("Only runs created before this timestamp.", { maxLength: 100 }),
        cursor,
        limit: number("Summary page size.", 1, 100),
      }, ["skill"]);
    case "runs.get":
    case "runs.cancel":
    case "runs.retry":
      return schema({ run }, ["run"]);
    case "runs.events":
      return schema({
        run,
        cursor,
        afterSeq: number("Legacy sequence-only cursor.", 0, 10_000_000),
        limit: number("Event page size.", 1, 500),
        maxChars: number("Maximum preview characters per event.", 100, 20_000),
      }, ["run"]);
    case "runs.log":
      return schema({
        run,
        maxChars: number("Maximum displayed log characters.", 100, 100_000),
        offset: number("Byte offset for ranged read.", 0, 1_000_000_000),
        limitBytes: number("Maximum bytes for ranged read.", 1, 1_000_000),
      }, ["run"]);
    case "runs.transcript":
      return schema({
        run,
        errorsOnly: boolean("Return only error rows."),
        aroundError: string("Transcript error step id.", { maxLength: 200 }),
        contextTurns: number("Turns around the selected error.", 1, 20),
        cursor,
        turnLimit: number("Maximum turns.", 1, 100),
        chronological: boolean("Return oldest-first rows."),
        narrative: boolean("Use narrative row formatting."),
        maxChars: number("Maximum output characters per row.", 100, 20_000),
        includeOutput: boolean("Include clipped row output."),
      }, ["run"]);
    case "runs.errors":
      return schema({
        run,
        cursor,
        maxChars: number("Maximum output characters per error.", 100, 20_000),
      }, ["run"]);
    default:
      throw new Error(`Missing exact Rudder MCP input schema for capability: ${id}`);
  }
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
    annotations: {
      title: tool.description.split(/[.;]/u, 1)[0] || tool.name,
      readOnlyHint: !tool.mutating,
      destructiveHint: RUDDER_MCP_DESTRUCTIVE_CAPABILITY_IDS.has(tool.capabilityId),
      idempotentHint: !tool.mutating
        || tool.capabilityId === "browser.reload"
        || tool.capabilityId === "browser.close",
      ...(RUDDER_MCP_OPEN_WORLD_CAPABILITY_IDS.has(tool.capabilityId) ? { openWorldHint: true } : {}),
    },
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
