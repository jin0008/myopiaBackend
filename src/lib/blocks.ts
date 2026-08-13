import prisma from "./prisma";

/**
 * User ids the viewer has blocked. Feed and comment queries exclude these so
 * blocking actually hides content (App Store guideline 1.2 expects the block
 * to take effect, not just be recorded).
 *
 * Returns an empty array for guests, which callers can pass straight into a
 * Prisma `notIn` — an empty `notIn` matches everything, so no special-casing.
 */
export async function blockedUserIds(viewerId: string | undefined): Promise<string[]> {
  if (!viewerId) return [];
  const rows = await prisma.user_block.findMany({
    where: { blocker_user_id: viewerId },
    select: { blocked_user_id: true },
  });
  return rows.map((r) => r.blocked_user_id);
}
