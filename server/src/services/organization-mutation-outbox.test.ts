import type { Db } from "@rudderhq/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const publishLiveEvent = vi.hoisted(() => vi.fn());

vi.mock("./live-events.js", () => ({
  publishLiveEvent,
}));

import { startOrganizationMutationOutboxPublisher } from "./organization-mutation-outbox.js";

const ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  org_id: "00000000-0000-4000-8000-000000000002",
  event_type: "activity.logged",
  payload: { action: "organization.branding_updated" },
  attempts: 1,
  claim_token: "00000000-0000-4000-8000-000000000003",
  claim_owner: "worker-1",
  lease_expires_at: "2099-01-01T00:00:00.000Z",
};

function createDb(rows: unknown[], resultShape: "rows" | "array" = "rows") {
  const execute = vi.fn()
    .mockResolvedValueOnce(resultShape === "rows" ? { rows } : rows)
    .mockResolvedValueOnce(resultShape === "rows" ? { rows } : rows)
    .mockResolvedValue({ rows: [] });
  const transaction = vi.fn(async (callback) => callback({ execute }));
  return {
    db: { execute, transaction } as unknown as Db,
    execute,
  };
}

describe("organization mutation outbox publisher", () => {
  beforeEach(() => {
    publishLiveEvent.mockReset();
  });

  it("publishes a claimed activity and acknowledges it", async () => {
    const { db, execute } = createDb([ROW]);
    const publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });

    await publisher.drain();
    await publisher.close();

    expect(publishLiveEvent).toHaveBeenCalledWith({
      orgId: ROW.org_id,
      type: ROW.event_type,
      payload: ROW.payload,
      dedupeKey: `organization-mutation-outbox:${ROW.id}`,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("accepts the array result returned by the postgres-js Drizzle driver", async () => {
    const { db, execute } = createDb([ROW], "array");
    const publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });

    await publisher.drain();
    await publisher.close();

    expect(publishLiveEvent).toHaveBeenCalledWith({
      orgId: ROW.org_id,
      type: ROW.event_type,
      payload: ROW.payload,
      dedupeKey: `organization-mutation-outbox:${ROW.id}`,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("keeps a failed or unknown event retryable and records the failure", async () => {
    const { db, execute } = createDb([
      { ...ROW, event_type: "unsupported.event" },
    ]);
    const publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });

    await publisher.drain();
    await publisher.close();

    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(3);
    const retryQuery = JSON.stringify(execute.mock.calls[2]?.[0]);
    expect(retryQuery).toContain("power");
    expect(retryQuery).toContain("last_error");
    expect(retryQuery).toContain("claim_token");
    expect(retryQuery).toContain("state = 'claimed'");
  });

  it("records a publication exception without acknowledging the row", async () => {
    const { db, execute } = createDb([ROW]);
    publishLiveEvent.mockImplementationOnce(() => {
      throw new Error("websocket unavailable");
    });
    const publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });

    await publisher.drain();
    await publisher.close();

    expect(execute).toHaveBeenCalledTimes(3);
    const retryQuery = JSON.stringify(execute.mock.calls[2]?.[0]);
    expect(retryQuery).toContain("last_error");
    expect(retryQuery).not.toContain("published_at");
  });

  it("claims only pending or expired leases and binds acknowledgement to the claim owner", async () => {
    const { db, execute } = createDb([ROW]);
    const publisher = startOrganizationMutationOutboxPublisher(db, {
      intervalMs: 60_000,
      leaseMs: 5_000,
      workerId: "worker-lease-test",
    });

    await publisher.drain();
    await publisher.close();

    const claimQuery = JSON.stringify(execute.mock.calls[0]?.[0]);
    const ownershipQuery = JSON.stringify(execute.mock.calls[1]?.[0]);
    const ackQuery = JSON.stringify(execute.mock.calls[2]?.[0]);
    expect(claimQuery).toContain("state = 'claimed'");
    expect(claimQuery).toContain("lease_expires_at");
    expect(claimQuery).toContain("gen_random_uuid()");
    expect(claimQuery).toContain("worker-lease-test");
    expect(ackQuery).toContain("claim_token");
    expect(ackQuery).toContain("claim_owner");
    expect(ownershipQuery).toContain("lease_expires_at > clock_timestamp()");
    expect(ownershipQuery).toContain("FOR UPDATE");
  });

  it("does not publish or acknowledge a claim that another worker reclaimed", async () => {
    const { db, execute } = createDb([ROW]);
    execute.mockReset()
      .mockResolvedValueOnce([ROW])
      .mockResolvedValue([]);
    const publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });
    await publisher.drain();
    await publisher.close();
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
