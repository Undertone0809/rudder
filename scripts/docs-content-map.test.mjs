import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  REPO_ROOT,
  collectIntegrityErrors,
  expectedRedirects,
  generatedArtifacts,
  loadManifest,
  renderLlms,
  resolveRedirect,
  runAlignment,
  validateManifestSchema,
  writeArtifactsAtomically,
} from "./docs-content-map.mjs";

const BATCH_2_CONCEPT_IDS = [
  "agents",
  "automations",
  "built-in-browser",
  "calendar",
  "goals-projects-issues",
  "plugins",
  "reviews-feedback-learning",
  "skills",
  "workspaces",
];

const BATCH_2_HOW_TO_IDS = [
  "configure-agent-runtime",
  "configure-feishu-integration",
  "create-agent",
  "create-automation",
  "export-import-organization",
  "issue-lifecycle",
  "manage-plugins",
  "manage-workspaces-and-library",
  "review-agent-work",
];

const BATCH_3_REFERENCE_IDS = [
  "issue-statuses",
  "runtime-types",
  "workspace-boundaries",
  "automation-output-routing",
  "permissions-and-platforms",
  "approvals-budgets-activity-reference",
];

const BATCH_3_REFERENCE_STRUCTURE = [
  "definition",
  "states",
  "constraints",
  "boundaries",
  "examples",
];

function readLocalizedPages(manifest, pageIds) {
  return pageIds.flatMap((pageId) => {
    const page = manifest.pages.find((candidate) => candidate.id === pageId);
    assert.ok(page, `manifest is missing ${pageId}`);
    return Object.entries(page.files).map(([locale, relativeFile]) => ({
      locale,
      page,
      relativeFile,
      source: fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8"),
    }));
  });
}

test("manifest parses and covers every current navigation page", () => {
  const manifest = loadManifest();
  const docsJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs/docs.json"), "utf8"));
  const routes = new Set(manifest.pages.flatMap((page) => Object.values(page.urls)));
  const navigation = docsJson.navigation.languages.flatMap((language) =>
    language.groups.flatMap((group) => group.pages.map((page) => page === "index" ? "/" : `/${page}`)),
  );
  for (const route of navigation) assert.ok(routes.has(route), `manifest is missing ${route}`);
});

test("redirect generation includes the activated Batch 3 aliases", () => {
  const manifest = loadManifest();
  const mintlify = expectedRedirects(manifest, "mintlify");
  const vercel = expectedRedirects(manifest, "vercel");
  assert.ok(mintlify.some((redirect) => redirect.source === "/home"));
  assert.ok(vercel.some((redirect) => redirect.has?.[0]?.type === "host"));
  assert.ok(mintlify.some((redirect) => redirect.source === "/concepts/control-plane"));
  assert.ok(vercel.some((redirect) => redirect.source === "/concepts/chat"));
});

test("deployment redirect artifacts keep legacy hosts out of staging and resolve production aliases in one hop", () => {
  const manifest = loadManifest();
  const mintlify = expectedRedirects(manifest, "mintlify");
  const staging = expectedRedirects(manifest, "vercel", { environment: "staging" });
  const production = expectedRedirects(manifest, "vercel", { environment: "production" });
  const legacyHost = "doc.rudder.zeeland.studio";
  const canonicalHost = "docs.rudderhq.dev";
  const prefixedAlias = "/en/concepts/messenger-approvals";
  assert.ok(!staging.some((redirect) => redirect.has?.some((condition) => condition.value === legacyHost)));
  assert.equal(resolveRedirect(mintlify, { host: canonicalHost, path: prefixedAlias }), "/concepts/chat-messenger");
  assert.equal(resolveRedirect(staging, { host: canonicalHost, path: prefixedAlias }), "/concepts/chat-messenger");
  assert.equal(
    resolveRedirect(production, { host: legacyHost, path: prefixedAlias }),
    "https://docs.rudderhq.dev/concepts/chat-messenger",
  );
  assert.equal(resolveRedirect(production, { host: canonicalHost, path: prefixedAlias }), "/concepts/chat-messenger");
  for (const [requestPath, destination] of [
    ["/", "https://docs.rudderhq.dev/"],
    ["/home", "https://docs.rudderhq.dev/"],
    ["/en", "https://docs.rudderhq.dev/"],
    ["/en/concepts/issues", "https://docs.rudderhq.dev/concepts/issues"],
    ["/manifest.json", "https://docs.rudderhq.dev/site.webmanifest"],
    ["/concepts/messenger-approvals", "https://docs.rudderhq.dev/concepts/chat-messenger"],
  ]) {
    assert.equal(resolveRedirect(production, { host: legacyHost, path: requestPath }), destination);
  }
  assert.equal(resolveRedirect(production, { host: canonicalHost, path: "/concepts/issues" }), null);
  assert.equal(resolveRedirect(staging, { host: legacyHost, path: "/concepts/issues" }), null);
});

test("manifest schema failures are path-qualified and integrity never dereferences malformed input", () => {
  const cases = [
    ["missing examples", (manifest) => { delete manifest.examples; }, "manifest.examples: expected array"],
    ["null files", (manifest) => { manifest.pages[0].files = null; }, "manifest.pages[0].files: expected locale map object"],
    ["missing contracts", (manifest) => { delete manifest.pages[0].contracts; }, "manifest.pages[0].contracts: expected object"],
    ["unknown page status", (manifest) => { manifest.pages[0].status = "published"; }, "manifest.pages[0].status: unknown page status published"],
    ["bad locale map", (manifest) => { manifest.pages[0].urls.fr = "/fr"; }, "manifest.pages[0].urls.fr: unknown locale"],
    ["malformed redirect policy", (manifest) => { manifest.redirect_policy.legacy_host_redirects[0].environments = ["preview"]; }, "unknown deployment environment preview"],
  ];
  for (const [label, mutate, expected] of cases) {
    const manifest = structuredClone(loadManifest());
    mutate(manifest);
    assert.ok(validateManifestSchema(manifest).some((error) => error.includes(expected)), label);
    assert.ok(collectIntegrityErrors({ manifest }).some((error) => error.includes(expected)), label);
  }
});

test("llms generation covers every active canonical Concept, How-to, Reference, and Project page", () => {
  const manifest = loadManifest();
  const llms = renderLlms(manifest);
  const requiredKinds = new Set(["concept", "how_to", "reference", "project"]);
  for (const page of manifest.pages.filter((item) => ["active", "transitional_active"].includes(item.status) && requiredKinds.has(item.kind))) {
    for (const url of Object.values(page.urls)) {
      assert.match(llms, new RegExp(`\\]\\(${manifest.base_url.replaceAll(".", "\\.")}${url === "/" ? "" : url}\\)`));
    }
  }
  assert.ok(!llms.includes("/concepts/messenger-approvals"));
});

test("Batch 2 concepts and how-to guides keep their case-led retrieval structure", () => {
  const manifest = loadManifest();
  const conceptAnchors = ["definition", "case", "when-useful", "operating-boundaries"];
  const howToAnchors = ["completed-state", "prerequisites", "case-backed-steps", "success-signal", "recovery"];

  for (const pageId of BATCH_2_CONCEPT_IDS) {
    const page = manifest.pages.find((candidate) => candidate.id === pageId);
    assert.equal(page.kind, "concept");
    assert.equal(page.example_ids.length, 1, `${pageId} must declare one continuing case`);
    assert.ok(page.source_docs.some((source) => source.endsWith(".md")), `${pageId} must cite at least one concrete source document`);
    assert.ok(page.contracts.primary.length + page.contracts.supporting.length > 0, `${pageId} must declare its owning contracts`);
    for (const anchors of Object.values(page.anchors)) assert.deepEqual(anchors, conceptAnchors, `${pageId} anchors`);
  }

  for (const pageId of BATCH_2_HOW_TO_IDS) {
    const page = manifest.pages.find((candidate) => candidate.id === pageId);
    assert.equal(page.kind, "how_to");
    assert.equal(page.example_ids.length, 1, `${pageId} must declare one case-backed procedure`);
    assert.ok(page.source_docs.some((source) => source.endsWith(".md")), `${pageId} must cite at least one concrete source document`);
    assert.ok(page.contracts.primary.length + page.contracts.supporting.length > 0, `${pageId} must declare its owning contracts`);
    for (const anchors of Object.values(page.anchors)) assert.deepEqual(anchors, howToAnchors, `${pageId} anchors`);
  }
});

test("Batch 2 prose preserves the core run, review, and governance distinctions", () => {
  const manifest = loadManifest();
  const pages = readLocalizedPages(manifest, [...BATCH_2_CONCEPT_IDS, ...BATCH_2_HOW_TO_IDS]);
  for (const { locale, relativeFile, source } of pages) {
    if (locale === "en") {
      assert.doesNotMatch(source, /[\u2013\u2014]/u, `${relativeFile} contains an en or em dash`);
      assert.doesNotMatch(source, /\b(?:roadmap|coming soon|planned feature)\b/iu, `${relativeFile} contains roadmap copy`);
    }
  }

  const agents = fs.readFileSync(path.join(REPO_ROOT, "docs/concepts/agents.mdx"), "utf8");
  assert.match(agents, /Agent Run/u);
  assert.match(agents, /runtime/u);
  assert.match(agents, /cost/u);
  assert.match(agents, /output/u);
  assert.match(agents, /raw evidence/u);

  const reviews = fs.readFileSync(path.join(REPO_ROOT, "docs/concepts/reviews-feedback-learning.mdx"), "utf8");
  assert.match(reviews, /Review[^\n]+Approval|Approval[^\n]+Review/u);
  const reviewsZh = fs.readFileSync(path.join(REPO_ROOT, "docs/zh/concepts/reviews-feedback-learning.mdx"), "utf8");
  assert.match(reviewsZh, /评审[^\n]+审批|审批[^\n]+评审/u);
});

test("Batch 2 keeps the mandatory Issue definition and the Agent Detail runtime label", () => {
  const issueDefinitionEn = "An issue is a durable task record with an explicit status and lifecycle. Use one when work needs a named owner, dependencies, or a review path; comments, agent runs, artifacts, and review decisions can stay with the same record.";
  const issueDefinitionZh = "Issue（任务单）是带有明确状态和生命周期的任务记录。需要指定负责人、跟踪依赖或安排评审时使用；评论、Agent 运行、产物和评审结论可以留在同一条记录中。";
  const goals = fs.readFileSync(path.join(REPO_ROOT, "docs/concepts/goals-projects-issues.mdx"), "utf8").replace(/\s+/gu, " ");
  const goalsZh = fs.readFileSync(path.join(REPO_ROOT, "docs/zh/concepts/goals-projects-issues.mdx"), "utf8");
  assert.ok(goals.includes(issueDefinitionEn), "English Goal/Project/Issue concept must use the mandatory Issue definition");
  assert.ok(goalsZh.includes(issueDefinitionZh), "Chinese Goal/Project/Issue concept must use the mandatory Issue（任务单） definition");

  for (const relativeFile of [
    "docs/how-to/configure-agent-runtime.mdx",
    "docs/zh/how-to/configure-agent-runtime.mdx",
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
    assert.match(source, /\*\*Test runtime chain\*\*/u, `${relativeFile} must use the Agent Detail runtime test label`);
    assert.doesNotMatch(source, /\*\*Test now\*\*/u, `${relativeFile} must not use the onboarding runtime test label`);
  }
});

test("Batch 2 procedures do not promise unsupported controls, statuses, or portable entities", () => {
  const readNormalized = (relativeFile) => fs
    .readFileSync(path.join(REPO_ROOT, relativeFile), "utf8")
    .replace(/\s+/gu, " ");

  const createAgent = readNormalized("docs/how-to/create-agent.mdx");
  const createAgentZh = readNormalized("docs/zh/how-to/create-agent.mdx");
  assert.match(createAgent, /After creating the Agent, open \*\*Configuration\*\*.*\*\*Capabilities\*\*.*\*\*Permissions\*\*.*\*\*Budget\*\*/u);
  assert.match(createAgentZh, /创建 Agent 后.*\*\*Configuration\*\*.*\*\*Capabilities\*\*.*\*\*Permissions\*\*.*\*\*Budget\*\*/u);
  assert.doesNotMatch(createAgent, /Review budget and permission settings, then create/u);
  assert.doesNotMatch(createAgentZh, /检查预算和权限设置，再创建 Agent/u);

  const createAutomation = readNormalized("docs/how-to/create-automation.mdx");
  const createAutomationZh = readNormalized("docs/zh/how-to/create-automation.mdx");
  assert.match(createAutomation, /browser's local timezone/u);
  assert.match(createAutomationZh, /浏览器本地时区/u);
  assert.doesNotMatch(createAutomation, /choose a schedule and timezone/iu);
  assert.doesNotMatch(createAutomationZh, /选择日程和时区/u);

  const automations = readNormalized("docs/concepts/automations.mdx");
  const automationsZh = readNormalized("docs/zh/concepts/automations.mdx");
  assert.match(automations, /active.*paused|paused.*active/u);
  assert.match(automationsZh, /启用.*暂停|暂停.*启用/u);
  assert.doesNotMatch(automations, /archiv/iu);
  assert.doesNotMatch(automationsZh, /归档/u);

  const portability = readNormalized("docs/how-to/export-import-organization.mdx");
  const portabilityZh = readNormalized("docs/zh/how-to/export-import-organization.mdx");
  assert.match(portability, /organization, Agents, projects, Issues, Automations, and Skills/u);
  assert.match(portability, /Goals, Library files, and organization resources are not included/u);
  assert.match(portability, /`goalId` is `null`/u);
  assert.doesNotMatch(portability, /Library files open/u);
  assert.match(portabilityZh, /组织、Agent、项目、Issue、自动化和技能/u);
  assert.match(portabilityZh, /目标、Library 文件和组织资料不会包含在软件包中/u);
  assert.match(portabilityZh, /`goalId` 为 `null`/u);
  assert.doesNotMatch(portabilityZh, /Library 文件可以打开/u);

  const manifest = loadManifest();
  const sourceExpectations = new Map([
    ["automations", ["ui/src/pages/Automations.tsx"]],
    ["create-agent", ["ui/src/pages/NewAgent.tsx", "ui/src/components/AgentConfigForm.tsx", "ui/src/pages/AgentDetail.tsx"]],
    ["create-automation", ["ui/src/pages/Automations.tsx"]],
    ["export-import-organization", [
      "packages/shared/src/types/organization-portability.ts",
      "server/src/services/knowledge-portability/organization-portability.export.ts",
      "server/src/services/knowledge-portability/organization-portability.import.ts",
    ]],
  ]);
  for (const [pageId, expectedSources] of sourceExpectations) {
    const page = manifest.pages.find((candidate) => candidate.id === pageId);
    for (const source of expectedSources) assert.ok(page.source_docs.includes(source), `${pageId} must track ${source}`);
  }
  const example = manifest.examples.find((candidate) => candidate.id === "organization-client-move");
  assert.match(example.starting_request, /Agents, projects, Issues, Automations, and Skills/u);
  assert.doesNotMatch(`${example.starting_request} ${example.intervention} ${example.artifacts.join(" ")}`, /Goals|Library files|organization resources/u);
});

test("Batch 3 atomically promotes the governance reference and retires transitional concept bodies", () => {
  const manifest = loadManifest();
  const governance = manifest.pages.find((page) => page.id === "approvals-budgets-activity-reference");

  assert.equal(manifest.pages.some((page) => page.id === "approvals-budgets-activity"), false);
  assert.equal(governance.status, "active");
  assert.equal(governance.llms, true);
  assert.equal(governance.metadata_enforcement, "strict");
  assert.deepEqual(governance.contracts.primary, [
    "APPROVAL.GOVERNED.ACTIONS.001",
    "BUDGET.ENFORCEMENT.001",
    "ACTIVITY.AUDIT.001",
  ]);
  assert.deepEqual(manifest.transitional_files, []);

  for (const relativeFile of [
    "docs/concepts/approvals-budgets-activity.mdx",
    "docs/zh/concepts/approvals-budgets-activity.mdx",
    "docs/concepts/chat.mdx",
    "docs/zh/concepts/chat.mdx",
    "docs/concepts/messenger.mdx",
    "docs/zh/concepts/messenger.mdx",
  ]) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, relativeFile)), false, `${relativeFile} must be retired`);
  }

  for (const contractId of governance.contracts.primary) {
    assert.equal(
      manifest.contract_ownership.find((ownership) => ownership.id === contractId)?.primary_page,
      governance.id,
      `${contractId} must move to the active reference`,
    );
  }

  const docsJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs/docs.json"), "utf8"));
  for (const language of docsJson.navigation.languages) {
    const allPages = language.groups.flatMap((group) => group.pages);
    assert.ok(allPages.includes(language.language === "en"
      ? "reference/approvals-budgets-activity"
      : "zh/reference/approvals-budgets-activity"));
    assert.ok(!allPages.some((page) => page.endsWith("concepts/approvals-budgets-activity")));
  }
});

test("Batch 3 references expose definition, state, constraint, boundary, and example sections", () => {
  const manifest = loadManifest();

  for (const { locale, page, relativeFile, source } of readLocalizedPages(manifest, BATCH_3_REFERENCE_IDS)) {
    assert.equal(page.kind, "reference");
    assert.equal(page.status, "active");
    for (const anchor of BATCH_3_REFERENCE_STRUCTURE) {
      assert.ok(page.anchors[locale].includes(anchor), `${page.id}/${locale} must declare #${anchor}`);
      assert.match(source, new RegExp(`<a id=["']${anchor}["']\\s*/>`), `${relativeFile} must expose #${anchor}`);
    }
    if (locale === "en") {
      assert.doesNotMatch(source, /[\u2013\u2014]/u, `${relativeFile} contains an en or em dash`);
      assert.doesNotMatch(source, /\s--\s/u, `${relativeFile} contains a prose double dash`);
    }
  }

  const governance = manifest.pages.find((page) => page.id === "approvals-budgets-activity-reference");
  for (const topicAnchor of [
    "approvals",
    "budgets-and-cost",
    "activity",
    "run-intelligence",
    "dashboard-calendar-and-inbox",
  ]) {
    for (const locale of manifest.locales) {
      assert.ok(governance.anchors[locale].includes(topicAnchor));
    }
  }

  const sharedConstants = fs.readFileSync(
    path.join(REPO_ROOT, "packages/shared/src/constants.ts"),
    "utf8",
  );
  const issueStatusBlock = sharedConstants.match(
    /export const ISSUE_STATUSES = \[([\s\S]*?)\] as const;/u,
  );
  assert.ok(issueStatusBlock, "shared ISSUE_STATUSES must remain discoverable");
  const issueStatuses = [...issueStatusBlock[1].matchAll(/"([^"]+)"/gu)].map(
    (match) => match[1],
  );
  for (const relativeFile of [
    "docs/reference/issue-statuses.mdx",
    "docs/zh/reference/issue-statuses.mdx",
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
    for (const status of issueStatuses) {
      assert.ok(source.includes(`\`${status}\``), `${relativeFile} must document ${status}`);
    }
    assert.match(source, /`cancelled`[\s\S]*`todo`/u, `${relativeFile} must explain how cancelled work reopens`);
  }

  const automationStatusBlock = sharedConstants.match(
    /export const AUTOMATION_RUN_STATUSES = \[([\s\S]*?)\] as const;/u,
  );
  assert.ok(automationStatusBlock, "shared AUTOMATION_RUN_STATUSES must remain discoverable");
  const automationStatuses = [...automationStatusBlock[1].matchAll(/"([^"]+)"/gu)].map(
    (match) => match[1],
  );
  for (const relativeFile of [
    "docs/reference/automation-output-routing.mdx",
    "docs/zh/reference/automation-output-routing.mdx",
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
    for (const status of automationStatuses) {
      assert.ok(source.includes(`\`${status}\``), `${relativeFile} must document ${status}`);
    }
  }

  const approvalStatusBlock = sharedConstants.match(
    /export const APPROVAL_STATUSES = \[([\s\S]*?)\] as const;/u,
  );
  assert.ok(approvalStatusBlock, "shared APPROVAL_STATUSES must remain discoverable");
  const approvalStatuses = [...approvalStatusBlock[1].matchAll(/"([^"]+)"/gu)].map(
    (match) => match[1],
  );
  for (const relativeFile of [
    "docs/reference/approvals-budgets-activity.mdx",
    "docs/zh/reference/approvals-budgets-activity.mdx",
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
    for (const status of approvalStatuses) {
      assert.ok(source.includes(`\`${status}\``), `${relativeFile} must document ${status}`);
    }
  }
});

test("Batch 3 governance topic map routes legacy topics to current owning pages", () => {
  const governance = fs.readFileSync(
    path.join(REPO_ROOT, "docs/reference/approvals-budgets-activity.mdx"),
    "utf8",
  );
  const governanceZh = fs.readFileSync(
    path.join(REPO_ROOT, "docs/zh/reference/approvals-budgets-activity.mdx"),
    "utf8",
  );

  for (const [source, prefix] of [[governance, ""], [governanceZh, "/zh"]]) {
    assert.match(source, /Legacy topic map|旧主题索引/u);
    assert.match(source, /\(#approvals\)/u);
    assert.match(source, /\(#budgets-and-cost\)/u);
    assert.match(source, /\(#activity\)/u);
    assert.ok(source.includes(`](${prefix}/concepts/agents)`));
    assert.ok(source.includes(`](${prefix}/concepts/overview)`));
    assert.ok(source.includes(`](${prefix}/concepts/calendar)`));
    assert.ok(source.includes(`](${prefix}/concepts/chat-messenger)`));
  }
});

test("Batch 3 legacy aliases are permanent, locale-safe, and resolve in one hop", () => {
  const manifest = loadManifest();
  const redirectCases = [
    ["/concepts/control-plane", "/reference/approvals-budgets-activity"],
    ["/zh/concepts/control-plane", "/zh/reference/approvals-budgets-activity"],
    ["/concepts/approvals-budgets-activity", "/reference/approvals-budgets-activity"],
    ["/zh/concepts/approvals-budgets-activity", "/zh/reference/approvals-budgets-activity"],
    ["/concepts/chat", "/concepts/chat-messenger"],
    ["/concepts/messenger", "/concepts/chat-messenger"],
    ["/zh/concepts/chat", "/zh/concepts/chat-messenger"],
    ["/zh/concepts/messenger", "/zh/concepts/chat-messenger"],
  ];

  for (const target of ["mintlify", "vercel"]) {
    const generated = expectedRedirects(manifest, target, { environment: "staging" });
    for (const [source, destination] of redirectCases) {
      assert.equal(resolveRedirect(generated, { host: "docs.rudderhq.dev", path: source }), destination);
      assert.equal(resolveRedirect(generated, { host: "docs.rudderhq.dev", path: destination }), null);
    }
  }

  for (const [source, destination] of redirectCases) {
    const redirect = manifest.redirects.find((candidate) => candidate.source === source);
    assert.equal(redirect?.status, "active", `${source} must be active`);
    assert.equal(redirect?.permanent, true, `${source} must be permanent`);
    assert.equal(redirect?.locale, source.startsWith("/zh/") ? "zh" : "en");
    assert.equal(redirect?.destination, destination);
  }
});

test("Batch 3 active docs do not link to retired concept routes or use control-plane prose", () => {
  const manifest = loadManifest();
  const retiredLink = /\]\(\/(?:zh\/)?concepts\/(?:approvals-budgets-activity|chat|messenger)(?:[)#])/u;
  for (const { page, relativeFile, source } of readLocalizedPages(
    manifest,
    manifest.pages.filter((page) => page.status === "active").map((page) => page.id),
  )) {
    assert.doesNotMatch(source, retiredLink, `${relativeFile} links to a retired canonical route`);
    assert.doesNotMatch(source, /\bcontrol[ -]plane\b/iu, `${relativeFile} uses legacy control-plane prose`);
    assert.equal(page.status, "active");
  }
});

test("Batch 3 Project pages keep GDPval facts, release history, and bilingual project entry points", () => {
  const manifest = loadManifest();
  const gdpval = manifest.pages.find((page) => page.id === "gdpval-harness");
  assert.equal(gdpval.kind, "project");
  assert.equal(gdpval.status, "active");
  assert.equal(gdpval.llms, true);
  assert.deepEqual(Object.keys(gdpval.files).sort(), ["en", "zh"]);

  for (const relativeFile of Object.values(gdpval.files)) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
    assert.match(source, /81\.7/u);
    assert.match(source, /75\.7/u);
    assert.match(source, /75\.6/u);
    assert.doesNotMatch(source, /correction notice|更正说明/iu);
    assert.doesNotMatch(source, /[\u2013\u2014]/u);
  }

  const chineseGdpval = fs.readFileSync(path.join(REPO_ROOT, gdpval.files.zh), "utf8");
  assert.match(chineseGdpval, /证据边界/u);
  const chineseGdpvalProse = chineseGdpval
    .replace(/^---\n[\s\S]*?\n---\n/u, "")
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]+`/gu, "")
    .replace(/^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*$/gmu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1");
  assert.doesNotMatch(chineseGdpvalProse, /\b(?:harness|pilot|cohort|case|rubric|judge|gold|workspace|session|memory|run)\b/iu);

  for (const pageId of ["about", "contact"]) {
    const page = manifest.pages.find((candidate) => candidate.id === pageId);
    assert.equal(page.kind, "project");
    assert.deepEqual(Object.keys(page.files).sort(), ["en", "zh"]);
    assert.equal(page.pairing_exception, null);
  }

  const about = fs.readFileSync(path.join(REPO_ROOT, "docs/about.mdx"), "utf8");
  assert.match(about, /Rudder is open-source software for assigning, running, reviewing, and improving\s+agent work\./u);
  assert.match(about, /It connects goals, tasks, knowledge, runs, reviews, budgets, and\s+workflows/u);
  assert.doesNotMatch(about, /[\u2013\u2014]/u);

  for (const relativeFile of ["docs/releases.mdx", "docs/zh/releases.mdx"]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
    assert.match(source, /historical terminology|历史术语/u);
    assert.match(source, /current (?:product )?guidance|当前产品说明/u);
    assert.match(source, /future (?:release )?entries|今后的发布记录/iu);
  }
});

test("generated artifacts are deterministic", () => {
  const manifest = loadManifest();
  assert.deepEqual(generatedArtifacts(manifest), generatedArtifacts(manifest));
});

test("integrity reports deterministic missing-file failures", () => {
  const manifest = structuredClone(loadManifest());
  manifest.pages.find((page) => page.id === "home").files.en = "docs/does-not-exist.mdx";
  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some((error) => error.includes("missing file docs/does-not-exist.mdx")));
});

test("integrity reports URL, anchor, contract, and primary-owner failures", () => {
  const manifest = structuredClone(loadManifest());
  const home = manifest.pages.find((page) => page.id === "home");
  home.urls.en = "/wrong-home";
  home.anchors.en.push("missing-anchor");
  home.contracts.supporting.push("NOT.A.REAL.CONTRACT.001");
  manifest.contract_ownership.find((ownership) => ownership.id === "RUN.RESULT.001").supporting_pages.push("home");
  manifest.contract_ownership.push({ ...manifest.contract_ownership[0] });
  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some((error) => error.includes("canonical must be")));
  assert.ok(errors.some((error) => error.includes("missing stable anchor #missing-anchor")));
  assert.ok(errors.some((error) => error.includes("unknown product contract NOT.A.REAL.CONTRACT.001")));
  assert.ok(errors.some((error) => error.includes("multiple primary owners")));
  assert.ok(errors.some((error) => error.includes("RUN.RESULT.001: supporting ownership does not match page declarations")));
});

test("public contract primary owners must be active", () => {
  const manifest = structuredClone(loadManifest());
  const contractId = "APPROVAL.GOVERNED.ACTIONS.001";
  const reservedPage = manifest.pages.find((page) => page.id === "approvals-budgets-activity-reference");
  reservedPage.status = "reserved_batch_3";

  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some((error) => error === `${contractId}: primary page ${reservedPage.id} must be active or transitional_active`));
});

test("retired transitional files stay empty while malformed entries remain detectable", () => {
  assert.deepEqual(loadManifest().transitional_files, []);

  const missingFileManifest = structuredClone(loadManifest());
  missingFileManifest.transitional_files.push({
    files: ["docs/concepts/not-real-chat.mdx"],
    retire_in: "test",
    replacement_page: "chat-messenger",
  });
  assert.ok(collectIntegrityErrors({ manifest: missingFileManifest }).some(
    (error) => error === "transitional_files[0]: missing transitional file docs/concepts/not-real-chat.mdx",
  ));

  const missingReplacementManifest = structuredClone(loadManifest());
  missingReplacementManifest.transitional_files.push({
    files: ["docs/concepts/chat-messenger.mdx"],
    retire_in: "test",
    replacement_page: "not-real-chat-replacement",
  });
  assert.ok(collectIntegrityErrors({ manifest: missingReplacementManifest }).some(
    (error) => error === "transitional_files[0]: unknown replacement page not-real-chat-replacement",
  ));

  const reservedReplacementManifest = structuredClone(loadManifest());
  reservedReplacementManifest.pages.find((page) => page.id === "approvals-budgets-activity-reference").status = "reserved_batch_3";
  reservedReplacementManifest.transitional_files.push({
    files: ["docs/concepts/chat-messenger.mdx"],
    retire_in: "test",
    replacement_page: "approvals-budgets-activity-reference",
  });
  assert.ok(collectIntegrityErrors({ manifest: reservedReplacementManifest }).some(
    (error) => error === "transitional_files[0]: replacement page approvals-budgets-activity-reference must be active or transitional_active",
  ));
});

test("integrity rejects duplicate redirect IDs and active sources", () => {
  const manifest = structuredClone(loadManifest());
  manifest.redirects.push({
    ...manifest.redirects.find((redirect) => redirect.id === "home"),
    id: "duplicate-home-source",
  });
  manifest.redirects.push({
    ...manifest.redirects.find((redirect) => redirect.id === "manifest"),
    source: "/old-manifest.json",
  });
  manifest.redirects.push({
    id: "canonical-collision",
    source: "/about",
    destination: "/contact",
    permanent: true,
    targets: ["mintlify"],
    status: "active",
  });
  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some((error) => error === "duplicate redirect id: manifest"));
  assert.ok(errors.some((error) => error === "duplicate active redirect source for mintlify: /home"));
  assert.ok(errors.some((error) => error === "duplicate active redirect source for vercel: /home"));
  assert.ok(errors.some((error) => error === "canonical-collision: active redirect source collides with canonical URL /about"));
});

test("redirect schema rejects invalid status, targets, and permanence", () => {
  const manifest = structuredClone(loadManifest());
  manifest.redirects.find((redirect) => redirect.id === "home").targets = [];
  manifest.redirects.find((redirect) => redirect.id === "en-root").targets = ["mintlify", "unknown-host"];
  manifest.redirects.find((redirect) => redirect.id === "en-catchall").permanent = false;
  manifest.redirects.find((redirect) => redirect.id === "manifest").status = "retired";
  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some((error) => error === "home: targets must be a nonempty array"));
  assert.ok(errors.some((error) => error === "en-root: unknown redirect target unknown-host"));
  assert.ok(errors.some((error) => error === "en-catchall: permanent must be true"));
  assert.ok(errors.some((error) => error === "manifest: unknown redirect status retired"));
});

test("integrity rejects redirect chains, loops, and unknown destinations", () => {
  const manifest = structuredClone(loadManifest());
  manifest.redirects.push(
    {id: "loop-a", source: "/old-a", destination: "/old-b", permanent: true, targets: ["mintlify"], status: "active"},
    {id: "loop-b", source: "/old-b", destination: "/old-a", permanent: true, targets: ["mintlify"], status: "active"},
    {id: "missing-destination", source: "/old-missing", destination: "/not-a-canonical-page", permanent: true, targets: ["mintlify"], status: "active"},
    {id: "absent-destination", source: "/old-absent", permanent: true, targets: ["mintlify"], status: "active"},
  );
  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some((error) => error === "redirect chain for mintlify: /old-a -> /old-b"));
  assert.ok(errors.some((error) => error.startsWith("redirect loop for mintlify:")));
  assert.ok(errors.some((error) => error === "missing-destination: invalid active redirect destination /not-a-canonical-page"));
  assert.ok(errors.some((error) => error === "absent-destination: missing redirect destination"));
});

test("integrity expands wildcard witnesses when detecting redirect chains", () => {
  const manifest = structuredClone(loadManifest());
  manifest.redirects.push(
    {id: "wildcard-chain-a", source: "/legacy/:path*", destination: "/middle/:path*", permanent: true, targets: ["mintlify"], status: "active"},
    {id: "wildcard-chain-b", source: "/middle/:path*", destination: "/concepts/overview", permanent: true, targets: ["mintlify"], status: "active"},
  );
  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some(
    (error) => error === "redirect chain for mintlify: /legacy/__docs_chain_probe__ -> /middle/__docs_chain_probe__",
  ));
});

test("integrity rejects alias ownership and language mismatches", () => {
  const manifest = structuredClone(loadManifest());
  const chatMessenger = manifest.pages.find((page) => page.id === "chat-messenger");
  chatMessenger.aliases.push("missing-chat-alias");
  manifest.redirects.find((redirect) => redirect.id === "messenger-approvals").destination = "/concepts/overview";
  manifest.redirects.find((redirect) => redirect.id === "zh-messenger-approvals").destination = "/concepts/chat-messenger";
  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some((error) => error === "chat-messenger: alias missing-chat-alias must resolve to exactly one manifest redirect"));
  assert.ok(errors.some((error) => error === "chat-messenger: alias messenger-approvals must redirect to /concepts/chat-messenger"));
  assert.ok(errors.some((error) => error.includes("Chinese alias redirects across languages")));
  assert.ok(errors.some((error) => error === "chat-messenger: alias zh-messenger-approvals must redirect to /zh/concepts/chat-messenger"));
});

test("migration aliases keep explicit ownership, locale, destination, and activation semantics", () => {
  const typoManifest = structuredClone(loadManifest());
  typoManifest.redirects.find((redirect) => redirect.id === "retire-control-plane").destination = "/reference/not-real";
  assert.ok(collectIntegrityErrors({ manifest: typoManifest }).some((error) => error.includes("invalid active redirect destination /reference/not-real")));

  const ownerManifest = structuredClone(loadManifest());
  ownerManifest.redirects.find((redirect) => redirect.id === "retire-chat").owner_page = "issues";
  assert.ok(collectIntegrityErrors({ manifest: ownerManifest }).some((error) => error === "chat-messenger: alias retire-chat owner_page must be chat-messenger"));

  const reservedManifest = structuredClone(loadManifest());
  reservedManifest.redirects.find((redirect) => redirect.id === "retire-control-plane").status = "reserved_batch_3";
  assert.equal(
    expectedRedirects(reservedManifest, "mintlify").some((redirect) => redirect.source === "/concepts/control-plane"),
    false,
  );
});

test("canonical route collision exemptions only recognize the approved legacy host", () => {
  const manifest = structuredClone(loadManifest());
  manifest.redirects.push({
    id: "host-hijack",
    source: "/about",
    destination: "/contact",
    permanent: true,
    targets: ["vercel"],
    status: "active",
    owner_page: "contact",
    locale: "en",
    has: [{ type: "host", value: "untrusted.example" }],
  });
  manifest.pages.find((page) => page.id === "contact").aliases.push("host-hijack");
  assert.ok(collectIntegrityErrors({ manifest }).some((error) => error === "host-hijack: active redirect source collides with canonical URL /about"));
});

test("conditional host redirects are Vercel-only and never lose host scope in Mintlify", () => {
  const manifest = structuredClone(loadManifest());
  manifest.redirects.push({
    id: "mintlify-host-hijack",
    source: "/about",
    destination: "/contact",
    permanent: true,
    targets: ["mintlify", "vercel"],
    status: "active",
    owner_page: "contact",
    locale: "en",
    has: [{ type: "host", value: "doc.rudder.zeeland.studio" }],
  });
  manifest.pages.find((page) => page.id === "contact").aliases.push("mintlify-host-hijack");
  const errors = collectIntegrityErrors({ manifest });
  assert.ok(errors.some((error) => error === "mintlify-host-hijack: conditional redirects may target only vercel"));
  assert.ok(errors.some((error) => error === "mintlify-host-hijack: active redirect source collides with canonical URL /about"));
});

test("Chinese UI label allowlist is sorted, unique, and covers all rewritten pages", () => {
  const allowlist = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "doc/engineering/public-docs/ui-label-allowlist.json"), "utf8"));
  assert.deepEqual(allowlist.labels, [...new Set(allowlist.labels)].sort());
  const manifest = loadManifest();
  const checkedFiles = [
    "docs/zh.mdx",
    "docs/zh/concepts/overview.mdx",
    "docs/zh/get-started/installation.mdx",
    "docs/zh/get-started/first-organization.mdx",
    "docs/zh/concepts/issues.mdx",
    "docs/zh/concepts/chat-messenger.mdx",
    ...[
      ...BATCH_2_CONCEPT_IDS,
      ...BATCH_2_HOW_TO_IDS,
      ...BATCH_3_REFERENCE_IDS,
      "gdpval-harness",
      "about",
      "contact",
    ]
      .map((pageId) => manifest.pages.find((page) => page.id === pageId).files.zh),
  ];
  const uiLabels = checkedFiles.flatMap((relativeFile) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
    const emphasized = [...source.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]);
    const inlineCodeLabels = [...source.matchAll(/`([^`\n]+)`/g)]
      .map((match) => match[1])
      .filter((label) => /^(?=.*[a-z])[A-Z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/u.test(label));
    return [...emphasized, ...inlineCodeLabels]
      .filter((label) => /[A-Za-z]/u.test(label) && /^[\x20-\x7e]+$/u.test(label));
  });
  assert.ok(uiLabels.includes("Inbox"), "extraction must cover the inline Inbox UI label");
  assert.ok(uiLabels.includes("Getting Started"), "extraction must cover backticked multiword UI labels");
  assert.ok(!uiLabels.includes("todo"), "lowercase status values are code, not UI-label exceptions");
  assert.ok(!uiLabels.includes("PATH"), "all-uppercase syntax is not a UI-label exception");
  for (const label of uiLabels) {
    assert.ok(allowlist.labels.includes(label), `allowlist is missing ${label}`);
  }

  const allowedBareEnglishTokens = new Set([
    "API", "Agent", "Brave", "BridgeMind", "Browser", "CDP", "CLI", "CRM", "Calendar", "Chat", "Chrome",
    "Claude", "Code", "Codex", "Cookie", "Cursor", "Dashboard", "Desktop", "Edge",
    "DOCX", "Duplex", "GDPval", "Gemini", "GitHub", "HTTP", "Inbox", "Issue", "Issues", "JavaScript", "Jira", "Lark", "Library",
    "Linux", "MCP", "Markdown", "Messenger", "Microsoft", "OpenCode", "PATH", "PDF", "POC", "PPTX", "Pi",
    "Releases", "Rod", "Rudder", "Tiny", "UAT", "UTC", "UUID", "Windows", "XLSX", "gpt-5.6-sol", "macOS", "webhook",
  ]);
  for (const relativeFile of new Set(checkedFiles)) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8")
      .replace(/^---\n[\s\S]*?\n---\n/u, "")
      .replace(/```[\s\S]*?```/gu, "")
      .replace(/`[^`\n]+`/gu, "")
      .replace(/\*\*[^*]+\*\*/gu, "")
      .replace(/https?:\/\/\S+/gu, "")
      .replace(/<[\s\S]*?>/gu, "")
      .replace(/^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*$/gmu, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1");
    const bareEnglishTokens = new Set(
      [...source.matchAll(/[A-Za-z][A-Za-z0-9+.-]*/gu)].map((match) => match[0]),
    );
    for (const token of bareEnglishTokens) {
      assert.ok(
        allowedBareEnglishTokens.has(token),
        `${relativeFile} must translate ordinary English token ${token} or format an allowlisted exact UI label`,
      );
    }
  }
});

test("integrity reports hreflang and locale-pair failures", () => {
  const hreflangManifest = structuredClone(loadManifest());
  hreflangManifest.pages.find((page) => page.id === "home").urls.zh = "/zh/changed-home";
  const hreflangErrors = collectIntegrityErrors({ manifest: hreflangManifest });
  assert.ok(hreflangErrors.some((error) => error.includes("home/en: hreflang_zh must be")));

  const localeManifest = structuredClone(loadManifest());
  delete localeManifest.pages.find((page) => page.id === "home").files.zh;
  const localeErrors = collectIntegrityErrors({ manifest: localeManifest });
  assert.ok(localeErrors.some((error) => error === "home: locale pair missing without pairing_exception"));
});

test("integrity reports navigation, sitemap, and stale llms failures", () => {
  const routeManifest = structuredClone(loadManifest());
  routeManifest.pages.find((page) => page.id === "overview").urls.en = "/concepts/unlisted-overview";
  const routeErrors = collectIntegrityErrors({ manifest: routeManifest });
  assert.ok(routeErrors.some((error) => error === "navigation/en: /concepts/overview has no active canonical page"));
  assert.ok(routeErrors.some((error) => error === "overview/en: missing from sitemap.xml"));

  const staleLlmsManifest = structuredClone(loadManifest());
  staleLlmsManifest.base_url = "https://stale.example.test";
  const staleLlmsErrors = collectIntegrityErrors({ manifest: staleLlmsManifest });
  assert.ok(staleLlmsErrors.some((error) => error === "docs/llms.txt is stale"));
});

test("alignment has no unclassified current reminders and remains warning-only", () => {
  const result = runAlignment();
  assert.equal(result.exitCode, 0);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.records.length > 0);
});

test("alignment classifications suppress only the reviewed content fingerprint", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "rudder-docs-alignment-"));
  try {
    fs.mkdirSync(path.join(root, "docs"));
    fs.mkdirSync(path.join(root, "source"));
    fs.writeFileSync(path.join(root, "docs/en.mdx"), "English\n");
    fs.writeFileSync(path.join(root, "docs/zh.mdx"), "中文\n");
    fs.writeFileSync(path.join(root, "source/fact.md"), "fact\n");
    const manifest = {
      alignment_reviews: "reviews.json",
      pages: [{
        id: "pair",
        status: "active",
        files: { en: "docs/en.mdx", zh: "docs/zh.mdx" },
        source_docs: ["source/fact.md"],
        contracts: { primary: [], supporting: [] },
        pairing_exception: null,
      }],
    };
    const first = runAlignment({ root, manifest, reviews: { allowed_classifications: ["intentional"], classifications: [] } });
    const record = first.records[0];
    const reviews = {
      allowed_classifications: ["intentional"],
      classifications: [{ ...record, classification: "intentional", reviewed_revision: "test-revision" }],
    };
    assert.ok(!runAlignment({ root, manifest, reviews }).warnings.includes(record.reminder));
    const emptyRevision = structuredClone(reviews);
    emptyRevision.classifications[0].reviewed_revision = "";
    assert.ok(runAlignment({ root, manifest, reviews: emptyRevision }).warnings.includes(record.reminder));
    const whitespaceRevision = structuredClone(reviews);
    whitespaceRevision.classifications[0].reviewed_revision = "   ";
    assert.ok(runAlignment({ root, manifest, reviews: whitespaceRevision }).warnings.includes(record.reminder));
    fs.writeFileSync(path.join(root, "source/fact.md"), "changed fact\n");
    assert.ok(runAlignment({ root, manifest, reviews }).warnings.includes(record.reminder));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real examples require existing permission and evidence locators", () => {
  const missingPermission = structuredClone(loadManifest());
  missingPermission.examples.find((example) => example.id === "steer-fix").permission_evidence = [];
  assert.ok(collectIntegrityErrors({ manifest: missingPermission }).some((error) => error.includes("permission_evidence")));

  const missingFile = structuredClone(loadManifest());
  missingFile.examples.find((example) => example.id === "steer-fix").evidence.push("docs/not-real.mdx#evidence");
  assert.ok(collectIntegrityErrors({ manifest: missingFile }).some((error) => error.includes("evidence locator is missing docs/not-real.mdx")));

  const missingAnchor = structuredClone(loadManifest());
  missingAnchor.examples.find((example) => example.id === "steer-fix").evidence.push("docs/releases.mdx#not-real");
  assert.ok(collectIntegrityErrors({ manifest: missingAnchor }).some((error) => error.includes("missing anchor #not-real")));

  const directoryLocator = structuredClone(loadManifest());
  directoryLocator.examples.find((example) => example.id === "steer-fix").evidence.push(".#x");
  assert.ok(collectIntegrityErrors({ manifest: directoryLocator }).some((error) => error.includes("locator must reference a file")));

  const traversalLocator = structuredClone(loadManifest());
  traversalLocator.examples.find((example) => example.id === "steer-fix").evidence.push(path.relative(REPO_ROOT, process.execPath));
  assert.ok(collectIntegrityErrors({ manifest: traversalLocator }).some((error) => error.includes("locator must stay within the repository root")));

  for (const invalidLocator of ["#anchor", "docs/releases.mdx#"]) {
    const invalid = structuredClone(loadManifest());
    invalid.examples.find((example) => example.id === "steer-fix").evidence.push(invalidLocator);
    assert.ok(collectIntegrityErrors({ manifest: invalid }).some((error) => error.includes("optional nonempty anchor")));
  }
});

function faultInjectedFileSystem({ renameSync, unlinkSync } = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync" && renameSync) return (source, destination) => renameSync(target, source, destination);
      if (property === "unlinkSync" && unlinkSync) return (filePath) => unlinkSync(target, filePath);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function atomicWriterFixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "rudder-docs-atomic-"));
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out/a.txt"), "old-a");
  fs.writeFileSync(path.join(root, "out/b.txt"), "old-b");
  return root;
}

test("atomic writer keeps committed destinations when backup cleanup fails", () => {
  const root = atomicWriterFixture();
  try {
    let injected = false;
    const fileSystem = faultInjectedFileSystem({
      unlinkSync(target, filePath) {
        if (!injected && filePath.includes(".bak-")) {
          injected = true;
          throw new Error("injected backup cleanup failure");
        }
        target.unlinkSync(filePath);
      },
    });
    const result = writeArtifactsAtomically(
      root,
      [["out/a.txt", "new-a"], ["out/b.txt", "new-b"]],
      { fileSystem },
    );
    assert.equal(result.committed, true);
    assert.ok(result.cleanupWarnings.some((warning) => warning.includes("injected backup cleanup failure")));
    assert.equal(fs.readFileSync(path.join(root, "out/a.txt"), "utf8"), "new-a");
    assert.equal(fs.readFileSync(path.join(root, "out/b.txt"), "utf8"), "new-b");
    const retainedBackup = fs.readdirSync(path.join(root, "out")).find((entry) => entry.includes(".bak-"));
    assert.ok(retainedBackup, "failed cleanup must retain its backup as recovery evidence");
    assert.ok(result.recoveryArtifacts.some((filePath) => filePath.endsWith(retainedBackup)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic writer restores originals and preserves staged evidence when install fails", () => {
  const root = atomicWriterFixture();
  try {
    const fileSystem = faultInjectedFileSystem({
      renameSync(target, source, destination) {
        if (source.includes(".tmp-") && destination.endsWith("b.txt")) {
          throw new Error("injected install failure");
        }
        target.renameSync(source, destination);
      },
    });
    let error;
    try {
      writeArtifactsAtomically(root, [["out/a.txt", "new-a"], ["out/b.txt", "new-b"]], { fileSystem });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.phase, "install");
    assert.equal(error?.committed, false);
    assert.deepEqual(error?.rollbackErrors, []);
    assert.equal(fs.readFileSync(path.join(root, "out/a.txt"), "utf8"), "old-a");
    assert.equal(fs.readFileSync(path.join(root, "out/b.txt"), "utf8"), "old-b");
    const temporaryFiles = fs.readdirSync(path.join(root, "out")).filter((entry) => entry.includes(".tmp-"));
    assert.equal(temporaryFiles.length, 2);
    assert.equal(new Set(temporaryFiles.map((entry) => fs.readFileSync(path.join(root, "out", entry), "utf8"))).size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic writer reports restore failures and retains backup and temporary recovery paths", () => {
  const root = atomicWriterFixture();
  try {
    const fileSystem = faultInjectedFileSystem({
      renameSync(target, source, destination) {
        if (source.includes(".tmp-") && destination.endsWith("b.txt")) {
          throw new Error("injected install failure");
        }
        if (source.includes("a.txt.bak-") && destination.endsWith("a.txt")) {
          throw new Error("injected restore failure");
        }
        target.renameSync(source, destination);
      },
    });
    let error;
    try {
      writeArtifactsAtomically(root, [["out/a.txt", "new-a"], ["out/b.txt", "new-b"]], { fileSystem });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.phase, "install");
    assert.equal(error?.committed, false);
    assert.ok(error?.rollbackErrors.some((message) => message.includes("a.txt.bak-") && message.includes("a.txt")));
    const recoveryNames = error.recoveryArtifacts.map((filePath) => path.basename(filePath));
    const backupName = recoveryNames.find((entry) => entry.includes("a.txt.bak-"));
    const temporaryName = recoveryNames.find((entry) => entry.includes("a.txt.tmp-"));
    assert.ok(backupName);
    assert.ok(temporaryName);
    assert.equal(fs.readFileSync(path.join(root, "out", backupName), "utf8"), "old-a");
    assert.equal(fs.readFileSync(path.join(root, "out", temporaryName), "utf8"), "new-a");
    assert.equal(fs.readFileSync(path.join(root, "out/b.txt"), "utf8"), "old-b");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("docs structure test is a gate in general CI and both docs deployment workflows", () => {
  for (const workflow of ["ci.yml", "docs-staging.yml", "docs-production.yml"]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", workflow), "utf8");
    assert.match(source, /run: pnpm docs:structure:test/u, `${workflow} must run docs:structure:test`);
  }
});
