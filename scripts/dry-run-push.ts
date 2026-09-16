/**
 * 오늘 알림이 누구에게 갈지 미리 본다. 아무것도 보내지 않는다.
 *
 *   npx tsx scripts/dry-run-push.ts            # 지금 시각 기준
 *   npx tsx scripts/dry-run-push.ts --hour 21  # 그 시각이라 치고
 *   npx tsx scripts/dry-run-push.ts --hour 19  # 일정 알림 시각
 *
 * 푸시는 한 번 잘못 보내면 되돌릴 수 없다. 그리고 잘못 받은 사람이 가장
 * 먼저 하는 일은 알림을 끄는 것이라, 되돌릴 수 없는 것이 하나 더 는다.
 * 그래서 보내기 전에 대상을 눈으로 본다.
 *
 * 고르는 규칙은 jobs/pushReminders.ts 와 같아야 의미가 있다. 두 벌로 두는
 * 대신 같은 판단을 여기서 다시 쓰고, 다르면 그 자체가 신호다 - 이 파일이
 * 옛 규칙을 들고 있으면 출력이 실제와 어긋나 곧 들킨다.
 *
 * 읽기만 한다.
 */
import prisma from "../src/lib/prisma";

const ACTIVE_WINDOW_DAYS = 14;

function nowKST(): { day: Date; hour: number } {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    day: new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate())),
    hour: k.getUTCHours(),
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const { day, hour: realHour } = nowKST();
  const hourArg = arg("hour");
  const hour = hourArg != null ? Number(hourArg) : realHour;

  console.log(`\n기준: ${ymd(day)} ${String(hour).padStart(2, "0")}시 (KST)`);
  if (hourArg != null) console.log(`  (실제 시각은 ${realHour}시 — --hour 로 바꿔 봄)`);

  /* ---- 1) 치료 챙김 ---- */
  console.log("\n[치료 챙김 알림]");

  const prefs = await prisma.notification_pref.findMany({
    where: { care_daily: true, care_hour: hour },
    select: { user_id: true },
  });
  let candidates = prefs.map((p) => p.user_id);
  if (hour === 21) {
    const noPref = await prisma.user.findMany({
      where: { notification_pref: null, parent_child_link: { some: {} } },
      select: { id: true },
    });
    candidates = [...new Set([...candidates, ...noPref.map((u) => u.id)])];
    console.log(`  설정 있음 ${prefs.length}명 + 설정 없음(기본 21시) ${noPref.length}명`);
  } else {
    console.log(`  이 시각으로 설정한 사람 ${prefs.length}명`);
  }

  if (candidates.length === 0) {
    console.log("  → 보낼 사람 없음");
  } else {
    const links = await prisma.parent_child_link.findMany({
      where: { user_id: { in: candidates } },
      select: { id: true, user_id: true, nickname: true },
    });
    const since = new Date(day);
    since.setUTCDate(since.getUTCDate() - ACTIVE_WINDOW_DAYS);
    const recent = await prisma.child_care_log.findMany({
      where: {
        parent_child_link_id: { in: links.map((l) => l.id) },
        kind: { in: ["atropine", "lens"] },
        done_on: { gte: since },
      },
      select: { parent_child_link_id: true, done_on: true },
    });
    const active = new Set(recent.map((r) => r.parent_child_link_id));
    const doneToday = new Set(
      recent.filter((r) => r.done_on.getTime() === day.getTime()).map((r) => r.parent_child_link_id),
    );

    console.log(`  아이 ${links.length}명 중`);
    console.log(`    최근 ${ACTIVE_WINDOW_DAYS}일 안에 치료를 체크한 적 있음: ${active.size}명`);
    console.log(`    그중 오늘 이미 체크함: ${[...active].filter((id) => doneToday.has(id)).length}명`);

    const pending = new Map<string, string[]>();
    for (const l of links) {
      if (!active.has(l.id) || doneToday.has(l.id)) continue;
      const names = pending.get(l.user_id) ?? [];
      if (l.nickname != null) names.push(l.nickname);
      pending.set(l.user_id, names);
    }

    // 이미 보낸 자국이 있으면 실제로는 건너뛴다.
    const already = await prisma.push_sent.findMany({
      where: { kind: "care_daily", day, user_id: { in: [...pending.keys()] } },
      select: { user_id: true },
    });
    const sentIds = new Set(already.map((a) => a.user_id));

    const targets = [...pending.entries()].filter(([u]) => !sentIds.has(u));
    console.log(`\n  → 보낼 대상 ${targets.length}명 (오늘 이미 보낸 ${sentIds.size}명 제외)`);
    await describe(targets.map(([u, names]) => ({ userId: u, note: names.join(", ") || "(애칭 없음)" })));
  }

  /* ---- 2) 일정 ---- */
  console.log("\n[일정 알림]  — 19시에만 나갑니다");
  if (hour !== 19) {
    console.log(`  지금은 ${hour}시라 나가지 않습니다.`);
  } else {
    const tomorrow = new Date(day);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const rows = await prisma.child_reminder.findMany({
      where: { due_on: tomorrow, done_at: null },
      include: { parent_child_link: { select: { user_id: true, nickname: true } } },
    });
    console.log(`  내일(${ymd(tomorrow)}) 예정 ${rows.length}건`);
    if (rows.length > 0) {
      const off = new Set(
        (
          await prisma.notification_pref.findMany({
            where: { user_id: { in: rows.map((r) => r.parent_child_link.user_id) }, reminder: false },
            select: { user_id: true },
          })
        ).map((p) => p.user_id),
      );
      const live = rows.filter((r) => !off.has(r.parent_child_link.user_id));
      console.log(`  → 보낼 대상 ${live.length}건 (끈 사람 ${rows.length - live.length}건 제외)`);
      await describe(
        live.map((r) => ({
          userId: r.parent_child_link.user_id,
          note: `${r.parent_child_link.nickname ?? "(애칭 없음)"} · ${
            r.kind === "lens_replace" ? "렌즈 교체" : "진료"
          }${r.memo ? " · " + r.memo : ""}`,
        })),
      );
    }
  }

  console.log("\n아무것도 보내지 않았습니다.\n");
}

/** 대상자를 사람이 알아볼 수 있게 찍는다. 토큰이 없으면 보내도 안 간다. */
async function describe(items: { userId: string; note: string }[]) {
  if (items.length === 0) return;
  const ids = [...new Set(items.map((i) => i.userId))];
  const [users, tokens] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }),
    prisma.push_token.findMany({ where: { user_id: { in: ids } }, select: { user_id: true } }),
  ]);
  const email = new Map(users.map((u) => [u.id, u.email]));
  const tokenCount = new Map<string, number>();
  for (const t of tokens) tokenCount.set(t.user_id, (tokenCount.get(t.user_id) ?? 0) + 1);

  for (const it of items) {
    const n = tokenCount.get(it.userId) ?? 0;
    console.log(
      `    ${(email.get(it.userId) ?? it.userId).padEnd(32)} 기기 ${n}대  ${it.note}` +
        (n === 0 ? "   ← 토큰 없음, 실제로는 안 감" : ""),
    );
  }
}

main()
  .catch((e) => {
    console.error("\n조회 중 오류:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
