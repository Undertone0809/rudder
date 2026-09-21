import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readServiceSource(fileName: string) {
  return readFileSync(new URL(`../services/${fileName}`, import.meta.url), "utf8");
}

describe("organization row writer mutation fences", () => {
  it("locks Goal authority before every Goal service business write", () => {
    const source = readServiceSource("goals.ts");
    const writerNames = [
      "start",
      "create",
      "update",
      "activate",
      "updatePlan",
      "checkpoint",
      "createActivity",
      "feedback",
      "createChangeProposal",
      "decideChangeProposal",
      "createResultProposal",
      "acceptResultProposal",
      "rejectResultProposal",
      "assignOwner",
      "setFocus",
      "evaluate",
      "remove",
    ];
    const starts = writerNames.map((name) => {
      const offset = source.indexOf(`    ${name}: async`);
      expect(offset, `${name} must remain a Goal service writer`).toBeGreaterThanOrEqual(0);
      return { name, offset };
    });

    for (const [index, { name, offset }] of starts.entries()) {
      const nextOffset = starts[index + 1]?.offset ?? source.length;
      const body = source.slice(offset, nextOffset);
      const lockOffset = body.search(/await lock(?:Node|GoalNode)?MutationAuthority\(/);
      const firstBusinessWrite = body.search(/\.(?:insert|update|delete)\(|\b(?:recordFeedback|evaluateInTransaction)\(/);

      expect(lockOffset, `${name} must acquire organization mutation authority`).toBeGreaterThanOrEqual(0);
      expect(firstBusinessWrite, `${name} must contain a business write`).toBeGreaterThanOrEqual(0);
      expect(lockOffset, `${name} must fence before its first business write`).toBeLessThan(firstBusinessWrite);
    }
  });

  it("locks Node authority before the issue counter write in the same transaction", () => {
    const source = readServiceSource("issues.ts");
    const transactionStart = source.indexOf("const createdIssue = await db.transaction(async (tx) => {");
    const lockCall = source.indexOf("await lockNodeMutationAuthority(tx, orgId);", transactionStart);
    const counterWrite = source.indexOf(".update(organizations)", transactionStart);

    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(source).toContain('from "./organization-mutation-fence.js"');
    expect(lockCall).toBeGreaterThan(transactionStart);
    expect(lockCall).toBeLessThan(counterWrite);
  });

  it("locks Node authority before the first cost ledger write in the same transaction", () => {
    const source = readServiceSource("costs.ts");
    const transactionStart = source.indexOf("const result = await db.transaction(async (tx) => {");
    const lockCall = source.indexOf("await lockNodeMutationAuthority(tx, orgId);", transactionStart);
    const ledgerWrite = source.indexOf(".insert(costEvents)", transactionStart);
    const organizationWrite = source.indexOf(".update(organizations)", transactionStart);

    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(source).toContain('from "./organization-mutation-fence.js"');
    expect(lockCall).toBeGreaterThan(transactionStart);
    expect(lockCall).toBeLessThan(ledgerWrite);
    expect(lockCall).toBeLessThan(organizationWrite);
  });

  it.each([
    "assets.ts",
    "chats.annotation-persistence.ts",
    "chats.queued-message-create.ts",
    "chats.ts",
    "issues.comments-attachments.ts",
    "issues.ts",
    "orgs.ts",
  ])("locks Node authority before every production asset write in %s", (fileName) => {
    const source = readServiceSource(fileName);
    const writes = [...source.matchAll(/\.(?:insert|delete)\(assets\)/g)];

    expect(writes.length, `${fileName} should contain the audited asset writes`).toBeGreaterThan(0);
    expect(source).toContain('from "./organization-mutation-fence.js"');
    for (const write of writes) {
      const writeOffset = write.index ?? -1;
      const transactionOffset = source.lastIndexOf("db.transaction(", writeOffset);
      const lockOffset = source.lastIndexOf("await lockNodeMutationAuthority", writeOffset);
      expect(lockOffset, `${fileName} asset write at ${writeOffset} must be fenced`).toBeGreaterThanOrEqual(0);
      if (transactionOffset >= 0) {
        expect(lockOffset).toBeGreaterThan(transactionOffset);
      }
      expect(lockOffset).toBeLessThan(writeOffset);
    }
  });
});
