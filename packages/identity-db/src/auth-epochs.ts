import { and, eq } from "drizzle-orm";
import type { IdentityDb } from "./client.js";
import {
  identityAuthState,
  identityDevices,
  identityUsers,
} from "./schema.js";

export const CURRENT_OFFLINE_GRANT_SCHEMA_EPOCH = 2;

export type OfflineGrantServerState = {
  authSchemaEpoch: number;
  accountAuthEpoch: number;
  deviceAuthEpoch: number;
};

export async function readOfflineGrantServerState(
  db: IdentityDb,
  input: { userId: string; deviceId: string },
): Promise<OfflineGrantServerState> {
  const [state] = await db
    .select({
      authSchemaEpoch: identityAuthState.offlineGrantSchemaEpoch,
      accountAuthEpoch: identityUsers.authEpoch,
      deviceAuthEpoch: identityDevices.authEpoch,
    })
    .from(identityUsers)
    .innerJoin(
      identityDevices,
      and(
        eq(identityDevices.id, input.deviceId),
        eq(identityDevices.userId, identityUsers.id),
      ),
    )
    .leftJoin(identityAuthState, eq(identityAuthState.id, "global"))
    .where(eq(identityUsers.id, input.userId))
    .limit(1);
  if (!state) throw new Error("invalid_grant");
  return {
    authSchemaEpoch:
      state.authSchemaEpoch ?? CURRENT_OFFLINE_GRANT_SCHEMA_EPOCH,
    accountAuthEpoch: state.accountAuthEpoch,
    deviceAuthEpoch: state.deviceAuthEpoch,
  };
}
