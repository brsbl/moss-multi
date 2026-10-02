// Every user has a default vault, created as "Home" at sign-up (A§7, A§11).
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { folders, userPrefs } from '../db/schema.ts';

export const DEFAULT_VAULT_NAME = 'Home';

/**
 * The user's default vault id: the recorded one while it is live, else their oldest live vault (preferring
 * "Home"), else a new "Home". Idempotent and safe to race: the live-vault-name index admits one "Home".
 */
export async function ensureDefaultVault(db: Db, userId: string): Promise<string> {
  const live = and(eq(folders.ownerUserId, userId), eq(folders.kind, 'vault'), isNull(folders.deletedAt));
  const [pref] = await db.select({ id: userPrefs.defaultVaultId }).from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
  const vaults = await db.select({ id: folders.id, name: folders.name }).from(folders).where(live)
    .orderBy(asc(folders.createdAt), asc(folders.id));
  if (pref?.id && vaults.some((v) => v.id === pref.id)) return pref.id;

  let vault = vaults.find((v) => v.name.toLowerCase() === DEFAULT_VAULT_NAME.toLowerCase()) ?? vaults[0];
  if (!vault) {
    await db.insert(folders)
      .values({ id: crypto.randomUUID(), ownerUserId: userId, createdBy: userId, name: DEFAULT_VAULT_NAME, kind: 'vault', createdAt: Date.now() })
      .onConflictDoNothing();
    // A concurrent caller may have won the insert; both read back the one row.
    [vault] = await db.select({ id: folders.id, name: folders.name }).from(folders)
      .where(and(live, sql`lower(${folders.name}) = ${DEFAULT_VAULT_NAME.toLowerCase()}`))
      .limit(1);
    if (!vault) throw new Error(`no ${DEFAULT_VAULT_NAME} vault for ${userId} after insert`);
  }
  await db.insert(userPrefs)
    .values({ userId, defaultVaultId: vault.id })
    .onConflictDoUpdate({ target: userPrefs.userId, set: { defaultVaultId: vault.id } });
  return vault.id;
}
