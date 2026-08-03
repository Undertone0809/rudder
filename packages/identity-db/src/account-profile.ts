import type { IdentityDb } from "./client.js";
import { identityUsers } from "./schema.js";
import { eq } from "drizzle-orm";

export type IdentityAccountProfile = {
  id: string;
  email: string;
  name: string;
  image: string | null;
};

export async function getIdentityAccountProfile(
  db: IdentityDb,
  userId: string,
): Promise<IdentityAccountProfile | null> {
  const rows = await db
    .select({
      id: identityUsers.id,
      email: identityUsers.email,
      name: identityUsers.name,
      image: identityUsers.image,
    })
    .from(identityUsers)
    .where(eq(identityUsers.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateIdentityAccountProfile(
  db: IdentityDb,
  input: { userId: string; image: string | null },
): Promise<IdentityAccountProfile | null> {
  const rows = await db
    .update(identityUsers)
    .set({ image: input.image, updatedAt: new Date() })
    .where(eq(identityUsers.id, input.userId))
    .returning({
      id: identityUsers.id,
      email: identityUsers.email,
      name: identityUsers.name,
      image: identityUsers.image,
    });
  return rows[0] ?? null;
}
