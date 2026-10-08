/**
 * 앱 계정을 지운다. 앱의 회원 탈퇴(DELETE /auth/me)와 운영자 삭제
 * (DELETE /app-stats/guardians/:id)가 같이 쓴다 - 두 벌이면 한쪽만 고쳐져
 * 운영자가 지운 계정에 후기·투표가 남는다.
 *
 * user 행을 지우면 FK 가 CASCADE 인 것들은 따라 지워진다. 문제는 커뮤니티
 * 투표·후기·신고·차단·알림 테이블인데, 이들은 user_id 를 들고 있으면서도
 * user 로의 FK 가 없다. 그냥 user 를 지우면 지워지지 않고 남아, 탈퇴한
 * 사람의 후기 본문과 user_id 가 계속 조회된다. 그래서 먼저 손으로 지운다.
 *
 * patient·measurement·refractive_error 의 creator_id 는 SET NULL 이라 병원이
 * 보유한 진료 기록 자체는 남는다(의료법상 병원 보존 의무).
 */
import prisma from "../lib/prisma";

export type DeleteResult = "ok" | "not_found" | "not_app_account";

export async function deleteAppAccount(uid: string): Promise<DeleteResult> {
  // 같은 user 테이블을 의료진 플랫폼(myopiamanage)도 쓴다. 의료진이나
  // 사이트 관리자 계정이 지워지면 그쪽 서비스가 함께 날아간다.
  const owner = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      is_site_admin: true,
      healthcare_professional: { select: { user_id: true } },
    },
  });
  if (owner == null) return "not_found";
  if (owner.is_site_admin || owner.healthcare_professional != null) return "not_app_account";

  await prisma.$transaction(async (tx) => {
    // 1) user 로의 FK 가 없어 CASCADE 가 닿지 않는 것들.
    await tx.poll_comment_like.deleteMany({ where: { user_id: uid } });
    await tx.poll_comment.deleteMany({ where: { user_id: uid } });
    await tx.poll_vote.deleteMany({ where: { user_id: uid } });
    // poll 을 지우면 그 안의 선택지·투표·댓글은 poll FK 를 타고 함께 지워진다.
    await tx.poll.deleteMany({ where: { user_id: uid } });
    await tx.hospital_review.deleteMany({ where: { user_id: uid } });
    await tx.user_block.deleteMany({
      where: { OR: [{ blocker_user_id: uid }, { blocked_user_id: uid }] },
    });
    await tx.notification.deleteMany({ where: { user_id: uid } });

    // 내가 신고한 건은 지운다. 나를 신고한 건은 다른 이용자를 보호하기 위한
    // 기록이라 남기되, 누구를 가리키는지는 지운다.
    await tx.content_report.deleteMany({ where: { reporter_user_id: uid } });
    await tx.content_report.updateMany({
      where: { target_user_id: uid },
      data: { target_user_id: null },
    });
    await tx.notification.updateMany({
      where: { actor_user_id: uid },
      data: { actor_user_id: null },
    });

    // 칼럼·배너·병원 프로필의 created_by 도 FK 가 없다. 이 셋은 웹 세션에서만
    // 채워지고 위에서 의료진·관리자 계정을 막았으니 실제로는 걸릴 일이 없지만,
    // "걸릴 일이 없다"에 기대면 나중에 경로가 하나 늘 때 조용히 깨진다.
    await tx.expert_column.updateMany({
      where: { created_by: uid },
      data: { created_by: null },
    });
    await tx.ad_banner.updateMany({
      where: { created_by: uid },
      data: { created_by: null },
    });
    await tx.hospital_profile.updateMany({
      where: { created_by: uid },
      data: { created_by: null },
    });

    // 2) 나머지는 user 행을 지우면 CASCADE 로 따라 지워진다.
    //    자녀·소셜 연결·동의 이력·게시글·댓글·좋아요·토큰 등.
    await tx.user.delete({ where: { id: uid } });
  });

  return "ok";
}

/**
 * 정지된 계정이면 본인에게 보여 줄 문장을, 아니면 null.
 * 로그인·소셜 로그인·토큰 갱신·앱 요청이 모두 이것을 본다.
 */
export async function suspensionMessage(uid: string): Promise<string | null> {
  const u = await prisma.user.findUnique({
    where: { id: uid },
    select: { suspended_at: true, suspended_reason: true },
  });
  if (u?.suspended_at == null) return null;
  return (
    "운영 정책에 따라 이용이 정지된 계정입니다." +
    (u.suspended_reason ? ` (사유: ${u.suspended_reason})` : "") +
    " 문의: myodoc@idx.ai.kr"
  );
}
