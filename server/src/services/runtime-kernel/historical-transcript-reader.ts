import type { Db } from "@rudderhq/db";
import { agentConfigRevisions, agents } from "@rudderhq/db";
import { and, desc, eq } from "drizzle-orm";
import { createTranscriptObjectReader } from "./transcript-object-store.js";
import { createTranscriptReader, type TranscriptReaderOptions } from "./transcript-reader.js";

/**
 * Chat and annotation reads use the same historical profile resolution as Run
 * Detail. Resolve against the Run's Agent/config revision, never the currently
 * selected Chat Agent. Lazy loading avoids initializing execution services when
 * a caller only needs legacy history or constructs a Chat service.
 */
export function createHistoricalTranscriptReader(
  db: Pick<Db, "select">,
  options: { includeObjects?: boolean } & Pick<TranscriptReaderOptions, "logStore" | "legacyReader"> = {},
) {
  return createTranscriptReader(db, {
    ...(options.logStore ? { logStore: options.logStore } : {}),
    ...(options.legacyReader ? { legacyReader: options.legacyReader } : {}),
    nativeReader: {
      async read(input) {
        const [agent] = await db.select({
          agentRuntimeType: agents.agentRuntimeType,
          agentRuntimeConfig: agents.agentRuntimeConfig,
          runtimeConfig: agents.runtimeConfig,
        }).from(agents).where(and(
          eq(agents.orgId, input.orgId),
          eq(agents.id, input.run.agentId),
        )).limit(1);
        if (!agent) {
          return { items: [], availability: "missing", completeness: "unknown", revision: "agent-missing" };
        }
        const revisions = await db.select().from(agentConfigRevisions).where(and(
          eq(agentConfigRevisions.orgId, input.orgId),
          eq(agentConfigRevisions.agentId, input.run.agentId),
        )).orderBy(desc(agentConfigRevisions.createdAt));
        const [{ createHistoricalRunRuntimeProviderCapabilityResolver }, { createRuntimeNativeTranscriptReaderHook }] =
          await Promise.all([
            import("../run-intelligence.js"),
            import("./provider-capabilities.js"),
          ]);
        return createRuntimeNativeTranscriptReaderHook(
          createHistoricalRunRuntimeProviderCapabilityResolver({ ...input.run, ...agent }, revisions),
        ).readRange(input);
      },
    },
    ...(options.includeObjects === false ? {} : { objectReader: createTranscriptObjectReader() }),
  });
}
