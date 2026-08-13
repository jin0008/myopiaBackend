import prisma from "./prisma";

/**
 * User ids the viewer has blocked. Feed and comment queries exclude these so
 * blocking actually hides content (App Store guideline 1.2 expects the block
 * to take effect, not just be recorded).
 *
 * Returns an empty array for guests.
 */
export async function blockedUserIds(viewerId: string | undefined): Promise<string[]> {
  if (!viewerId) return [];
  const rows = await prisma.user_block.findMany({
    where: { blocker_user_id: viewerId },
    select: { blocked_user_id: true },
  });
  return rows.map((r) => r.blocked_user_id);
}

/**
 * `user_id` filter fragment to spread into a feed/comment `where` clause.
 *
 * Deliberately returns `{}` rather than `{ user_id: { notIn: [] } }` when
 * nothing is blocked — which is the overwhelmingly common case, including every
 * logged-out reader. Prisma does treat an empty `notIn` as "match everything",
 * but the community feed is not the place to depend on that: if it ever
 * resolved the other way the whole feed would silently return zero rows for
 * everyone. Omitting the key entirely can't fail that way.
 */
export async function authorBlockFilter(
  viewerId: string | undefined,
): Promise<{ user_id?: { notIn: string[] } }> {
  const hidden = await blockedUserIds(viewerId);
  return hidden.length === 0 ? {} : { user_id: { notIn: hidden } };
}
