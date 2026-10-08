import { describe, expect, it, vi } from "vitest";
import { sendMessengerState } from "./messenger-state-bridge.js";
import type { RustFoundationActor, RustFoundationBridge } from "./rust-foundation-bridge.js";

const actor = { type: "board", userId: "owner", source: "local_implicit" } as RustFoundationActor;
describe("Messenger state transport", () => {
  it("forwards native status and bytes without business projection", async () => {
    const response = { status: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), send: vi.fn() };
    const body = Buffer.from('{"error":"unchanged"}');
    const messengerState = vi.fn().mockResolvedValue({ status: 409, contentType: "application/json; charset=utf-8", body });
    const input = { operation: "savedViewGet" as const, id: "id" };
    await sendMessengerState(response as never, { messengerState } as unknown as RustFoundationBridge, actor, "org", input);
    expect(messengerState).toHaveBeenCalledWith(actor, "org", input);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.send).toHaveBeenCalledWith(body);
  });
  it("fails closed for an absent or failed authority", async () => {
    const input = { operation: "savedViewGet" as const, id: "id" };
    await expect(sendMessengerState({} as never, undefined, actor, "org", input)).rejects.toMatchObject({ status: 503 });
    await expect(sendMessengerState({} as never, { messengerState: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as RustFoundationBridge, actor, "org", input)).rejects.toMatchObject({ status: 503 });
  });
});
