import type { RequestHandler } from "express";
import prisma from "./prisma";
import { getAuthSession } from "./session";

/**
 * 안경처방전 먼저 보여 줄 사람. 테스트 서버가 없어 운영에서 몇 명에게만 연다.
 * RX_PILOT_EMAILS="a@x.com,b@y.com" - 이 이메일 + 사이트 관리자만.
 * RX_PILOT_EMAILS="*" - 모두에게 연다(정식 오픈).
 * 비어 있으면 사이트 관리자만 - 변수를 빠뜨려도 실수로 전체 공개되지 않게.
 * 바꾼 뒤엔 백엔드 재시작만 하면 된다(웹 다시 빌드 필요 없음).
 */
export function isRxPilot(user: { email: string | null; is_site_admin: boolean } | null): boolean {
  if (!user) return false;
  const raw = (process.env.RX_PILOT_EMAILS ?? "").trim();
  if (raw === "*") return true;
  if (user.is_site_admin) return true;
  const allow = raw.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return !!user.email && allow.includes(user.email.toLowerCase());
}

export const rxPilotRequired: RequestHandler = async (req, res, next) => {
  // 라우터 맨 앞이라 아직 로그인 미들웨어(authSession 채우기) 전이다 - 직접 읽는다.
  const id = (req.authSession ?? (await getAuthSession(req)))?.user_id;
  const user = id ? await prisma.user.findUnique({ where: { id }, select: { email: true, is_site_admin: true } }) : null;
  // 로그인 안 했으면 뒤 미들웨어가 401 을 낸다.
  if (user && !isRxPilot(user)) {
    res.status(404).json({ message: "not_found" });
    return;
  }
  next();
};
