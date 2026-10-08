import express from "express";
import { Prisma } from "@prisma/client";

import prisma from "../lib/prisma";
import { siteAdminRequired } from "../lib/middlewares";
import zod from "zod";

import { auditContextFromRequest, writeAuditLog } from "../services/audit";
import { deleteAppAccount } from "../services/appAccount";
import { revokeAllRefreshTokens } from "../lib/mobileAuth";

const router = express.Router();

/**
 * 앱 보호자. 앱으로 가입하면 normal_user 가 생긴다(mobile.ts). 의료진이 앱에
 * 로그인해도 생기므로, 같은 user 표를 쓰는 의료진·사이트 관리자는 뺀다.
 *
 * user.created_at 은 시간대 없는 UTC 라 한국 날짜는 9시간을 더해 읽는다.
 */
const GUARDIANS = Prisma.sql`
  WITH g AS (
    SELECT u.id, u.created_at
    FROM "user" u
    JOIN normal_user n ON n.user_id = u.id
    LEFT JOIN healthcare_professional h ON h.user_id = u.id
    WHERE h.user_id IS NULL AND NOT u.is_site_admin
  )`;

/** 집계 SQL 은 bigint 를 돌려준다. JSON 은 bigint 를 못 싣는다. */
const n = (v: unknown) => Number(v ?? 0);

/**
 * GET /app-stats — 마이오닥 앱 보호자 가입 현황. 숫자만 준다 - 이름·이메일은
 * 싣지 않는다.
 */
router.get("/", siteAdminRequired, async (_req, res) => {
  const [counts, daily, methods, children, active] = await Promise.all([
    prisma.$queryRaw<{ total: bigint; today: bigint; last7: bigint; month: bigint }[]>`
      ${GUARDIANS}
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE (created_at + interval '9 hours')::date
                               = (now() AT TIME ZONE 'Asia/Seoul')::date) AS today,
        count(*) FILTER (WHERE (created_at + interval '9 hours')::date
                               > (now() AT TIME ZONE 'Asia/Seoul')::date - 7) AS last7,
        count(*) FILTER (WHERE date_trunc('month', created_at + interval '9 hours')
                               = date_trunc('month', now() AT TIME ZONE 'Asia/Seoul')) AS month
      FROM g`,
    // 가입이 없는 날도 0 으로 채운다. 빠진 날이 있으면 막대 사이가 벌어지지 않아
    // 하루 쉰 것이 안 보인다.
    prisma.$queryRaw<{ day: string; count: bigint }[]>`
      ${GUARDIANS}
      -- 날짜는 문자열로 받는다. date 를 Date 로 바꿔 주는지는 드라이버마다 달라 기대지 않는다.
      SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0) AS count
      FROM generate_series(
        (now() AT TIME ZONE 'Asia/Seoul')::date - 29,
        (now() AT TIME ZONE 'Asia/Seoul')::date,
        interval '1 day') d
      LEFT JOIN (
        SELECT (created_at + interval '9 hours')::date AS day, count(*) AS n
        FROM g GROUP BY 1
      ) c ON c.day = d::date
      ORDER BY d`,
    // 한 사람이 둘 이상으로 들어올 수 있다(이메일 가입 후 카카오 연결). 방법마다
    // 그 방법을 쓰는 사람 수라, 합이 전체보다 클 수 있다.
    prisma.$queryRaw<{ method: string; count: bigint }[]>`
      ${GUARDIANS}
      SELECT 'email' AS method, count(*) AS count
      FROM password_auth p JOIN g ON g.id = p.user_id
      UNION ALL
      SELECT o.provider AS method, count(DISTINCT o.user_id) AS count
      FROM oauth_identity o JOIN g ON g.id = o.user_id
      GROUP BY o.provider`,
    prisma.$queryRaw<{ children: bigint; linked: bigint }[]>`
      ${GUARDIANS}
      SELECT
        (SELECT count(*) FROM parent_child_link pc JOIN g ON g.id = pc.user_id) AS children,
        (SELECT count(DISTINCT chl.parent_child_link_id)
           FROM child_hospital_link chl
           JOIN parent_child_link pc ON pc.id = chl.parent_child_link_id
           JOIN g ON g.id = pc.user_id
          WHERE chl.status = 'active') AS linked`,
    // 접속은 따로 적지 않는다. 앱은 로그인·토큰 갱신 때마다 새 리프레시 토큰을
    // 받으므로 그것으로 '최근에 앱을 연 사람'을 어림한다.
    prisma.$queryRaw<{ active7: bigint; active30: bigint }[]>`
      ${GUARDIANS}
      SELECT
        count(DISTINCT t.user_id) FILTER (WHERE t.created_at > now() - interval '7 days') AS active7,
        count(DISTINCT t.user_id) FILTER (WHERE t.created_at > now() - interval '30 days') AS active30
      FROM mobile_refresh_token t JOIN g ON g.id = t.user_id`,
  ]);

  const c = counts[0];
  const byMethod = Object.fromEntries(methods.map((m) => [m.method, n(m.count)]));
  res.json({
    total: n(c?.total),
    today: n(c?.today),
    last7: n(c?.last7),
    thisMonth: n(c?.month),
    daily: daily.map((d) => ({ day: d.day, count: n(d.count) })),
    methods: {
      email: byMethod.email ?? 0,
      kakao: byMethod.kakao ?? 0,
      naver: byMethod.naver ?? 0,
      google: byMethod.google ?? 0,
      apple: byMethod.apple ?? 0,
    },
    children: n(children[0]?.children),
    linkedChildren: n(children[0]?.linked),
    active7: n(active[0]?.active7),
    active30: n(active[0]?.active30),
  });
});

/** 보호자 목록 한 쪽에 몇 명. */
const PAGE_SIZE = 50;

/**
 * GET /app-stats/guardians?q=&page= — 보호자 목록(최신 가입순, 50명씩).
 *
 * 문의 응대용이다("로그인이 안 돼요" → 이메일·아이디로 찾기). 그래서 계정을
 * 알아보는 데 필요한 것만 준다: 이메일, 아이디, 가입일·방법, 자녀·연동 수,
 * 최근 접속. 자녀 이름·생년월일·측정값 같은 민감정보는 싣지 않는다.
 *
 * 개인정보를 여는 화면이라 볼 때마다 누가·언제·무엇으로 찾았는지 감사 기록에
 * 남긴다(audit_log READ). 기록을 못 남기면 보여 주지 않는다.
 */
router.get("/guardians", siteAdminRequired, async (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const filter =
    q === "" ? Prisma.sql`TRUE` : Prisma.sql`(u.email ILIKE ${like} OR p.username ILIKE ${like})`;

  const rows = await prisma.$queryRaw<
    {
      id: string;
      joined: string;
      email: string | null;
      username: string | null;
      providers: string[] | null;
      children: bigint;
      linked: bigint;
      last_seen: string | null;
      suspended_on: string | null;
      suspended_reason: string | null;
      total: bigint;
    }[]
  >`
    ${GUARDIANS}
    SELECT
      g.id,
      to_char(g.created_at + interval '9 hours', 'YYYY-MM-DD HH24:MI') AS joined,
      u.email,
      p.username,
      (SELECT array_agg(DISTINCT o.provider ORDER BY o.provider)
         FROM oauth_identity o WHERE o.user_id = g.id) AS providers,
      (SELECT count(*) FROM parent_child_link pc WHERE pc.user_id = g.id) AS children,
      (SELECT count(DISTINCT chl.parent_child_link_id)
         FROM child_hospital_link chl
         JOIN parent_child_link pc ON pc.id = chl.parent_child_link_id
        WHERE pc.user_id = g.id AND chl.status = 'active') AS linked,
      (SELECT to_char(max(t.created_at) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')
         FROM mobile_refresh_token t WHERE t.user_id = g.id) AS last_seen,
      to_char(u.suspended_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS suspended_on,
      u.suspended_reason,
      count(*) OVER () AS total
    FROM g
    JOIN "user" u ON u.id = g.id
    LEFT JOIN password_auth p ON p.user_id = g.id
    WHERE ${filter}
    ORDER BY g.created_at DESC
    LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;

  await writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "user",
    action: "READ",
    newValue: { view: "myodoc_guardian_list", q, page, shown: rows.length },
  });

  res.json({
    page,
    pageSize: PAGE_SIZE,
    total: n(rows[0]?.total),
    guardians: rows.map((r) => ({
      id: r.id,
      joined: r.joined,
      email: r.email,
      username: r.username,
      // 아이디가 있으면 이메일로 가입한 것이다(password_auth).
      methods: [...(r.username != null ? ["email"] : []), ...(r.providers ?? [])],
      children: n(r.children),
      linkedChildren: n(r.linked),
      lastSeen: r.last_seen,
      suspendedOn: r.suspended_on,
      suspendedReason: r.suspended_reason,
    })),
  });
});

/** 앱 보호자인가. 같은 user 표의 의료진·관리자 계정은 여기서 손대지 않는다. */
async function isGuardian(id: string): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id },
    select: {
      is_site_admin: true,
      normal_user: { select: { user_id: true } },
      healthcare_professional: { select: { user_id: true } },
    },
  });
  return u != null && u.normal_user != null && u.healthcare_professional == null && !u.is_site_admin;
}

const suspendSchema = zod.object({ reason: zod.string().trim().min(1).max(200) });

/**
 * POST /app-stats/guardians/:id/suspend — 앱 이용을 막는다.
 *
 * 로그인·토큰 갱신·앱 요청이 모두 막히고(services/appAccount), 들고 있던
 * 토큰도 지워 기기마다 로그아웃된다. 기록은 지우지 않는다 - 풀면 그대로 쓴다.
 * 사유는 본인이 다시 로그인할 때 보인다.
 */
router.post("/guardians/:id/suspend", siteAdminRequired, async (req, res) => {
  const parsed = suspendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "정지 사유를 적어 주세요(200자 이내)." });
    return;
  }
  const id = String(req.params.id);
  if (!(await isGuardian(id))) {
    res.status(404).json({ message: "앱 보호자 계정이 아닙니다." });
    return;
  }
  await prisma.user.update({
    where: { id },
    data: { suspended_at: new Date(), suspended_reason: parsed.data.reason },
  });
  await revokeAllRefreshTokens(id);
  await writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "user",
    recordId: id,
    action: "UPDATE",
    changedFields: ["suspended_at", "suspended_reason"],
    newValue: { suspended: true, reason: parsed.data.reason },
  });
  res.json({ ok: true });
});

/** POST /app-stats/guardians/:id/unsuspend — 정지를 푼다. */
router.post("/guardians/:id/unsuspend", siteAdminRequired, async (req, res) => {
  const id = String(req.params.id);
  if (!(await isGuardian(id))) {
    res.status(404).json({ message: "앱 보호자 계정이 아닙니다." });
    return;
  }
  await prisma.user.update({
    where: { id },
    data: { suspended_at: null, suspended_reason: null },
  });
  await writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "user",
    recordId: id,
    action: "UPDATE",
    changedFields: ["suspended_at", "suspended_reason"],
    newValue: { suspended: false },
  });
  res.json({ ok: true });
});

/**
 * DELETE /app-stats/guardians/:id — 계정을 지운다. 앱의 회원 탈퇴와 같은
 * 함수다(자녀 기록·글·후기가 지워지고, 병원 진료 기록은 남는다). 되돌릴 수 없다.
 */
router.delete("/guardians/:id", siteAdminRequired, async (req, res) => {
  const id = String(req.params.id);
  if (!(await isGuardian(id))) {
    res.status(404).json({ message: "앱 보호자 계정이 아닙니다." });
    return;
  }
  const before = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  const r = await deleteAppAccount(id);
  if (r !== "ok") {
    res.status(r === "not_found" ? 404 : 409).json({ message: "지울 수 없는 계정입니다." });
    return;
  }
  // user 행이 지워져 FK 를 걸 수 없으니 recordId 와 이메일을 값으로 남긴다.
  await writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "user",
    recordId: id,
    action: "DELETE",
    oldValue: { email: before?.email ?? null, by: "admin" },
  });
  res.json({ ok: true });
});

export default router;
