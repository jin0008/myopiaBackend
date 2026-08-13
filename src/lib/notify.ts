import prisma from "./prisma";

export type NotificationType =
  | "post_comment"
  | "post_reply"
  | "post_like"
  | "comment_like"
  | "poll_comment"
  | "poll_reply"
  | "poll_comment_like";

function snippet(s: string | null | undefined, max = 80): string | null {
  if (s == null) return null;
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * Record a notification.
 *
 * Deliberately swallows its own errors: a notification is a side effect of the
 * action the user actually asked for, and failing to write one must never turn
 * a successful comment into a 500.
 *
 * Two things are never notified:
 *   - your own actions (liking your own post shouldn't ping you)
 *   - actions by someone the recipient has blocked, which would route around
 *     the block that guideline 1.2 requires to actually hide them
 */
export async function notify(args: {
  userId: string;
  actorUserId: string | null;
  type: NotificationType;
  targetType: "post" | "poll";
  targetId: string;
  title?: string | null;
  preview?: string | null;
}): Promise<void> {
  try {
    if (args.actorUserId != null && args.actorUserId === args.userId) return;
    if (args.actorUserId != null) {
      const blocked = await prisma.user_block.findUnique({
        where: {
          blocker_user_id_blocked_user_id: {
            blocker_user_id: args.userId,
            blocked_user_id: args.actorUserId,
          },
        },
        select: { blocker_user_id: true },
      });
      if (blocked != null) return;
    }
    await prisma.notification.create({
      data: {
        user_id: args.userId,
        actor_user_id: args.actorUserId,
        type: args.type,
        target_type: args.targetType,
        target_id: args.targetId,
        title: snippet(args.title, 60),
        preview: snippet(args.preview),
      },
    });
  } catch (err) {
    console.error("[notify] failed", err);
  }
}
