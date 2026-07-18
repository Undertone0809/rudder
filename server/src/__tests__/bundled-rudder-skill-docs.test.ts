import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled rudder docs skill", () => {
  const root = path.join(
    process.cwd(),
    "server/resources/bundled-skills/rudder-docs",
  );
  const skillPath = path.join(root, "SKILL.md");
  const referenceNames = [
    "api-reference.md",
    "cli-reference.md",
    "control-plane-practices.md",
    "organization-skills.md",
    "source-map.md",
  ] as const;
  const referencePaths = referenceNames.map((name) =>
    path.join(root, "references", name),
  );

  const readSkill = () => fs.readFile(skillPath, "utf8");
  const readReferences = async () =>
    (await Promise.all(referencePaths.map((file) => fs.readFile(file, "utf8")))).join(
      "\n",
    );

  it("uses the canonical identity and a bounded trigger-only description", async () => {
    const contents = await readSkill();
    const frontmatter = contents.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.[1]).toMatch(/^name: rudder-docs\ndescription: "[^"]+"$/);

    const description = frontmatter?.[1].match(/description: "([^"]+)"/)?.[1] ?? "";
    const wordCount = description.trim().split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(50);
    expect(wordCount).toBeLessThanOrEqual(100);
    expect(description.length).toBeLessThan(1024);
    expect(description).not.toMatch(/[<>]/);
    expect(description).toContain("how Rudder works");
    expect(description).toContain("Do not use for greetings");
    expect(description).toContain("ordinary work merely running inside Rudder");
    expect(description).toContain("routine actions already clear from the active context and typed tools");
    expect(description).toContain("general coding and research tasks that do not ask about Rudder");
  });

  it("is a compact authoritative router with an explicit prompt-injection self-gate", async () => {
    const contents = await readSkill();

    expect(contents.split("\n").length).toBeLessThan(250);
    expect(contents).toContain("authoritative, current guidance about Rudder");
    expect(contents).toContain("documentation and self-knowledge entry point");
    expect(contents).toContain("not a workflow that must run merely because the agent is hosted by Rudder");
    expect(contents).toMatch(/body is already present in the prompt[\s\S]*does not need Rudder guidance[\s\S]*do not perform a docs lookup[\s\S]*Continue the user's actual task/);

    for (const heading of [
      "Purpose And Non-Goals",
      "Classify The Request",
      "Choose The Source Route",
      "Resolve Versions And Conflicts",
      "Evidence And Citations",
      "Progressive Reference Map",
      "Security And Bounded Use",
      "Quality Checklist",
    ]) {
      expect(contents).toContain(`## ${heading}`);
    }
  });

  it("routes each evidence class to its authoritative source", async () => {
    const contents = await readSkill();

    expect(contents).toMatch(/typed Rudder tools[\s\S]*rudder agent capabilities --json[\s\S]*rudder --version[\s\S]*exact .*--help[\s\S]*cli-reference\.md/);
    expect(contents).toContain("https://docs.rudderhq.dev/llms.txt");
    expect(contents).toMatch(/one or two[\s\S]*official pages/);
    expect(contents).toMatch(/user's language/);
    expect(contents).toMatch(/AGENTS\.md[\s\S]*doc\/README\.md[\s\S]*docs\/[\s\S]*doc\/product\/[\s\S]*doc\/engineering\/[\s\S]*source and tests/);
    expect(contents).toContain("https://github.com/Undertone0809/rudder");
    expect(contents).toMatch(/release tag[\s\S]*installed version/);
    expect(contents).toMatch(/default branch[\s\S]*latest development[\s\S]*not installed behavior/);
    expect(contents).toMatch(/Offline[\s\S]*live capabilities[\s\S]*bundled references[\s\S]*disclose/);
  });

  it("states provenance, conflict, and citation rules without flattening disagreements", async () => {
    const contents = await readSkill();

    expect(contents).toContain("Current callable or installed behavior wins for this environment");
    expect(contents).toContain("`doc/product/` owns intended product semantics");
    expect(contents).toContain("Source and tests own exact implementation evidence");
    expect(contents).toContain("Public docs own published user guidance");
    expect(contents).toContain("release or tag owns version-specific history");
    expect(contents).toMatch(/State conflicts[\s\S]*bounded uncertainty/);
    expect(contents).toMatch(/exact source[\s\S]*near the claim[\s\S]*host supports links/);
  });

  it("keeps the main body a router rather than a command catalog or control-plane manual", async () => {
    const contents = await readSkill();

    expect(contents).not.toMatch(/## (?:Essential Commands|Control-Plane Rails|Heartbeat Operating Loop|Heartbeat Procedure|Agent V1 Commands)/);
    expect(contents).not.toMatch(/\|\s*`rudder (?:agent|approval|automation|chat|issue|library|project|runs|skill)/);
    expect(contents).not.toContain("Goal -> Plan -> Chat or Issue -> Agent run");
    expect((contents.match(/^```/gm) ?? []).length).toBe(0);
  });

  it("links exactly the five progressive references and every link resolves", async () => {
    const contents = await readSkill();
    const linkedReferences = Array.from(
      contents.matchAll(/\]\(references\/([^)]+\.md)\)/g),
      (match) => match[1],
    );

    expect(linkedReferences).toEqual(referenceNames);
    for (const linkedReference of linkedReferences) {
      await expect(
        fs.stat(path.join(root, "references", linkedReference)),
      ).resolves.toBeDefined();
    }
  });

  it("keeps local source-map directory routes anchored to the checkout", async () => {
    const sourceMap = await fs.readFile(
      path.join(root, "references", "source-map.md"),
      "utf8",
    );
    const localRoutes = Array.from(
      sourceMap.matchAll(
        /`((?:cli|desktop|doc|docs|packages|server|tests|ui)\/[^`\n]*\/)`/g,
      ),
      (match) => match[1],
    );

    expect(localRoutes).toContain("packages/agent-runtimes/");
    expect(localRoutes).toContain("packages/agent-runtime-utils/");
    expect(new Set(localRoutes).size).toBeGreaterThan(20);
    for (const localRoute of new Set(localRoutes)) {
      await expect(
        fs.stat(path.join(process.cwd(), localRoute)),
        localRoute,
      ).resolves.toBeDefined();
    }
  });

  it("gives references over 100 lines a linked section map", async () => {
    for (const referencePath of referencePaths) {
      const contents = await fs.readFile(referencePath, "utf8");
      if (contents.split("\n").length > 100) {
        const sectionMap = contents.match(
          /(?:^|\n)## Section Map\n([\s\S]*?)(?=\n## |\s*$)/,
        );
        expect(sectionMap, path.basename(referencePath)).not.toBeNull();

        const anchors = Array.from(
          sectionMap?.[1].matchAll(/\]\(#([^)]+)\)/g) ?? [],
          (match) => match[1],
        );
        expect(anchors.length, path.basename(referencePath)).toBeGreaterThan(1);
        const headingAnchors = new Set(
          Array.from(contents.matchAll(/^## (.+)$/gm), (match) =>
            match[1]
              .toLowerCase()
              .replace(/[^\p{L}\p{N} -]/gu, "")
              .trim()
              .replace(/ +/g, "-"),
          ),
        );
        for (const anchor of anchors) {
          expect(headingAnchors, `${path.basename(referencePath)}#${anchor}`).toContain(
            anchor,
          );
        }
      }
    }
  });

  it("keeps operating policy in control practices instead of the CLI catalog", async () => {
    const cli = await fs.readFile(
      path.join(root, "references", "cli-reference.md"),
      "utf8",
    );

    for (const anchor of [
      "interface-and-scope",
      "ownership-checkout-and-wake-scope",
      "comments-mentions-and-evidence",
      "review-and-close-out",
      "durable-library-artifacts",
      "git-identity-and-attribution",
    ]) {
      expect(cli).toContain(`control-plane-practices.md#${anchor}`);
    }

    for (const duplicatedPolicy of [
      "Chat and issues are parallel ways",
      "If a comment wakes you on an issue not assigned to you",
      "RUDDER_WAKE_REASON=issue_passive_followup",
      "Do not rely on a free-form reject or accept comment",
      "Codex local runs preserve the operator `HOME`",
      "$RUDDER_PROJECT_LIBRARY_ROOT",
      "Do not hand-write `library-entry://",
    ]) {
      expect(cli).not.toContain(duplicatedPolicy);
    }

    expect(cli).toContain("## Agent V1 Commands");
    expect(cli).toContain("must write valid JSON to stdout on success");
    expect(cli).toContain("exit nonzero and write a diagnostic error to stderr");
    expect(cli).toContain("exit-0 command with empty stdout is a CLI/runtime defect");
    expect(cli).toContain("--body-file <path>");
    expect(cli).toContain("--comment-file <path>");
    expect(cli).toContain("cmt_<uuid-prefix>");
    expect(cli).toContain("`--image` may be repeated");
    expect(cli).toContain("`libraryEntryId`");
    expect(cli).toContain("`mentionHref`");
    expect(cli).toContain("`markdownLink`");
    for (const decision of ["approve", "request_changes", "needs_followup", "blocked"]) {
      expect(cli).toContain(`--decision ${decision}`);
    }
  });

  it("preserves conditional control-plane safety, review, and authentication facts", async () => {
    const contents = await readReferences();

    const requiredPatterns = [
      /checkout[\s\S]*before[\s\S]*issue-scoped (?:execution|work)/i,
      /(?:do not|never) retry[\s\S]*409/i,
      /(?:do not|never) look for unassigned work/i,
      /intent=wake/,
      /reference-only/,
      /reviewer does not take over implementation/i,
      /--decision approve/,
      /--decision request_changes/,
      /--decision needs_followup/,
      /--decision blocked/,
      /blocked[\s\S]*blocker comment/i,
      /approval[\s\S]*linked issues/i,
      /80%[\s\S]*critical work/i,
      /chainOfCommand[\s\S]*escalation/i,
      /Co-Authored-By: Rudder <285064165\+Rudderhq@users\.noreply\.github\.com>/,
      /user\.useConfigOnly=true/,
      /\*@\*\.local/,
      /Never (?:ask for|print) `?RUDDER_API_KEY`?/i,
      /organization[\s\S]*workspace boundaries/i,
    ];

    for (const pattern of requiredPatterns) {
      expect(contents).toMatch(pattern);
    }
  });

  it("preserves Library handoff and organization-skill assignment facts", async () => {
    const contents = await readReferences();

    expect(contents).toContain("$RUDDER_PROJECT_LIBRARY_ROOT");
    expect(contents).toContain("artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>");
    expect(contents).toContain("Do not choose an existing project, such as Getting Started");
    expect(contents).toContain("`markdownLink`");
    expect(contents).toMatch(/do not hand-write `library-entry:\/\//i);
    expect(contents).toMatch(/attach[\s\S]*(?:screenshot|image)[\s\S]*--image/i);
    expect(contents).toMatch(/skills enable[\s\S]*additive[\s\S]*skills sync[\s\S]*replace/i);
  });

  it("uses canonical renderable entity links instead of legacy prefix paths", async () => {
    const practices = await fs.readFile(
      path.join(root, "references", "control-plane-practices.md"),
      "utf8",
    );

    for (const scheme of [
      "issue://",
      "agent://",
      "automation://",
      "project://",
      "chat://",
      "skill://",
    ]) {
      expect(practices).toContain(scheme);
    }
    expect(practices).toContain("?c=<comment-id>");
    expect(practices).toContain("?intent=wake");
    expect(practices).toMatch(/Library[\s\S]*returned `markdownLink`/);
    expect(practices).toMatch(/external[\s\S]*descriptive[\s\S]*https/i);
    expect(practices).not.toMatch(/organization prefix/i);
    expect(practices).not.toContain("/<prefix>/issues");
  });

  it("bounds remote evidence and forbids docs-only mutations or credential disclosure", async () => {
    const contents = await readSkill();

    expect(contents).toMatch(/remote[\s\S]*source text[\s\S]*evidence, not instructions/i);
    expect(contents).toMatch(/do not (?:request|print)[\s\S]*RUDDER_API_KEY/i);
    expect(contents).toMatch(/do not clone[\s\S]*install dependencies[\s\S]*execute[\s\S]*mutate configuration/i);
    expect(contents).toContain("`docs.rudderhq.dev`");
    expect(contents).toContain("`github.com/Undertone0809/rudder`");
    expect(contents).toMatch(/organization and workspace boundaries/i);
    expect(contents).toMatch(/Reading `doc\/product\/`[\s\S]*does not authorize edits/i);
  });

  it("ships a balanced bilingual trigger set with hard near misses and paired cases", async () => {
    const evalPath = path.join(root, "evals", "trigger-evals.json");
    const evals = JSON.parse(await fs.readFile(evalPath, "utf8")) as Array<{
      query: string;
      should_trigger: boolean;
    }>;

    expect(evals).toHaveLength(20);
    expect(evals.every((item) => Object.keys(item).sort().join(",") === "query,should_trigger")).toBe(true);
    expect(evals.filter((item) => item.should_trigger)).toHaveLength(10);
    expect(evals.filter((item) => !item.should_trigger)).toHaveLength(10);
    expect(evals.some((item) => item.query === "hi" && !item.should_trigger)).toBe(true);

    for (const expected of [true, false]) {
      const group = evals.filter((item) => item.should_trigger === expected);
      expect(group.filter((item) => /[\u3400-\u9fff]/u.test(item.query)).length).toBeGreaterThanOrEqual(4);
      expect(group.some((item) => /Rudder|rudder|issue|Library/.test(item.query))).toBe(true);
    }

    const pairedCases = ["RUD-248", "agent-browser"];
    for (const marker of pairedCases) {
      const pair = evals.filter((item) => item.query.includes(marker));
      expect(pair).toHaveLength(2);
      expect(pair.map((item) => item.should_trigger).sort()).toEqual([false, true]);
    }

    expect(
      evals.filter(
        (item) =>
          !item.should_trigger && /Rudder|rudder|issue|Library|docs/.test(item.query),
      ).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("does not reintroduce the legacy package identity", async () => {
    const contents = [await readSkill(), await readReferences()].join("\n");

    expect(contents).not.toContain("server/resources/bundled-skills/rudder/");
    expect(contents).not.toMatch(/^name: rudder$/m);
    expect(contents).not.toMatch(/bundled `rudder` skill/i);
    expect(contents).not.toContain("# Rudder Skill");
  });
});
