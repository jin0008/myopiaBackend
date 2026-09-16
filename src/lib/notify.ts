import prisma from "./prisma";
import { pushToUser, wantsPush } from "./push";

export type NotificationType =
  /** 병원이 보호자 앱과의 연동을 끊었다. 예고 없이 차트에서 그 병원의
   *  측정값이 사라지므로 반드시 알려야 한다. */
  | "hospital_unlinked"
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
  targetType: "post" | "poll" | "child";
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

    // 표에 쌓는 것만으로는 앱을 열어야 보인다. 댓글이 달린 것을 그날 알
    // 방법이 없으면 사람들은 돌아오지 않는다.
    //
    // 병원 연동 해제는 끄지 못한다. 예고 없이 차트에서 그 병원의 측정값이
    // 사라지는 일이라, 모르고 지나가면 안 된다.
    const forced = args.type === "hospital_unlinked";
    if (forced || (await wantsPush(args.userId, "community"))) {
      await pushToUser(args.userId, {
        title: pushTitle(args.type, args.title),
        body: snippet(args.preview, 120) ?? snippet(args.title, 120) ?? "",
        path: pushPath(args.targetType, args.targetId),
      });
    }
  } catch (err) {
    console.error("[notify] failed", err);
  }
}

/** 알림 종류를 한 줄로. 폰 알림은 제목만 보고 열지 말지 정한다. */
function pushTitle(type: NotificationType, title: string | null | undefined): string {
  switch (type) {
    case "hospital_unlinked":
      return "병원 연동이 해제되었습니다";
    case "post_comment":
    case "poll_comment":
      return "내 글에 댓글이 달렸습니다";
    case "post_reply":
    case "poll_reply":
      return "내 댓글에 답글이 달렸습니다";
    case "post_like":
      return "내 글을 좋아합니다";
    case "comment_like":
    case "poll_comment_like":
      return "내 댓글을 좋아합니다";
    default:
      return snippet(title, 60) ?? "새 알림";
  }
}

/**
 * 눌렀을 때 갈 곳.
 *
 * 알림 목록으로만 보내면 방금 읽은 그 알림을 목록에서 다시 찾아 눌러야
 * 한다. 자녀 관련은 목록으로 보낸다 - 연동 해제는 어느 화면 하나로
 * 데려가는 것보다 무슨 일이 있었는지 먼저 읽는 편이 낫다.
 */
function pushPath(targetType: "post" | "poll" | "child", targetId: string): string {
  if (targetType === "post" || targetType === "poll") return `/post/${targetId}`;
  return "/notifications";
}
