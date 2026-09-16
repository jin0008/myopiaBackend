import prisma from "../lib/prisma";
import { pushToUser } from "../lib/push";

/**
 * 정해진 시각에 보내는 알림.
 *
 * 두 가지다.
 *   - 매일 하는 치료(아트로핀·드림렌즈)를 아직 체크하지 않았을 때
 *   - 잊지 마세요에 적어 둔 진료 예정일·렌즈 교체일 하루 전
 *
 * 한 시간에 한 번 돈다. 분 단위로 고르게 하면 매분 깨워야 하고, 그렇게
 * 세밀할 이유가 없다 - "9시쯤"이면 충분한 종류의 알림이다.
 *
 * 이미 체크한 사람에게는 보내지 않는다. 다 한 일을 하라고 조르면 알림을
 * 끄게 된다. 알림을 끄면 정작 필요한 날도 못 받는다.
 */

/** 지금 한국 시각의 날짜와 시. 서버가 한국에 있다는 보장이 없다. */
function nowKST(): { day: Date; hour: number } {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    // DATE 칸에 넣을 값이라 UTC 자정이어야 그 날짜 그대로 저장된다.
    day: new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate())),
    hour: k.getUTCHours(),
  };
}

/** 최근 이만큼 안에 한 번이라도 체크했으면 그 치료를 하는 중으로 본다. */
const ACTIVE_WINDOW_DAYS = 14;

/**
 * 이 사람에게 오늘 이 알림을 보낸 적이 있나. 없으면 자국을 남기고 true.
 *
 * 크론이 겹쳐 돌거나 서버가 재시작되어도 두 번 가지 않게 한다. 먼저
 * 꽂아 본 쪽만 보내는 방식이라, 두 실행이 동시에 들어와도 하나만 이긴다.
 */
async function claim(userId: string, kind: string, day: Date): Promise<boolean> {
  try {
    await prisma.push_sent.create({ data: { user_id: userId, kind, day } });
    return true;
  } catch {
    // 이미 있다(유일 제약). 보낸 적이 있다는 뜻이다.
    return false;
  }
}

/** 매일 하는 치료를 아직 체크하지 않은 보호자에게. */
async function careDaily(): Promise<number> {
  const { day, hour } = nowKST();

  // 이 시각에 받기로 한 사람만. 설정 줄이 없으면 기본값(21시)이라
  // 그 시각에만 걸린다.
  const prefs = await prisma.notification_pref.findMany({
    where: { care_daily: true, care_hour: hour },
    select: { user_id: true },
  });
  const explicit = new Set(prefs.map((p) => p.user_id));

  let candidates = [...explicit];
  if (hour === 21) {
    // 설정한 적 없는 사람들. 줄이 없으면 기본값으로 받는 것이 규칙이라
    // 여기서 함께 집어야 한다.
    const noPref = await prisma.user.findMany({
      where: { notification_pref: null, parent_child_link: { some: {} } },
      select: { id: true },
    });
    candidates = [...new Set([...candidates, ...noPref.map((u) => u.id)])];
  }
  if (candidates.length === 0) return 0;

  // 아이가 있고, 오늘 아직 아무것도 체크하지 않은 사람.
  const links = await prisma.parent_child_link.findMany({
    where: { user_id: { in: candidates } },
    select: { id: true, user_id: true, nickname: true },
  });
  if (links.length === 0) return 0;

  // 치료만 센다. 같은 표에 야외활동도 들어가는데, 산책을 체크했다고
  // 안약을 넣은 것은 아니다. 아무 줄이나 있으면 넘어가게 두면, 매일
  // 산책만 기록하는 집에는 알림이 영영 안 간다.
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

  // 지금 그 치료를 하는 중인 아이만 챙긴다.
  //
  // 어떤 아이가 아트로핀이나 드림렌즈를 하는지 따로 적어 두는 곳이 없어,
  // 최근에 체크한 적이 있는지로 가린다. 안 그러면 두 치료를 다 하지 않는
  // 집까지 매일 알림을 받는다 - 한 번도 해 본 적 없는 일을 하라고 매일
  // 조르면, 그 사람이 가장 먼저 하는 일은 알림을 끄는 것이다.
  //
  // "하던 사람이 오늘 빠뜨렸다"는 알릴 값어치가 있고, "해 본 적 없다"는
  // 알림이 아니라 권유다. 권유는 알림이 할 일이 아니다.
  const active = new Set(recent.map((r) => r.parent_child_link_id));
  const doneLinks = new Set(
    recent.filter((r) => r.done_on.getTime() === day.getTime()).map((r) => r.parent_child_link_id),
  );

  // 아이가 여럿이면 한 명만 남아 있어도 보낸다. 사람마다 한 통이다 -
  // 아이 수만큼 울리면 그것부터 끄고 싶어진다.
  const pending = new Map<string, string[]>();
  for (const l of links) {
    if (!active.has(l.id)) continue;
    if (doneLinks.has(l.id)) continue;
    const names = pending.get(l.user_id) ?? [];
    if (l.nickname != null) names.push(l.nickname);
    pending.set(l.user_id, names);
  }

  let sent = 0;
  for (const [userId, names] of pending) {
    if (!(await claim(userId, "care_daily", day))) continue;
    const who = names.length === 1 ? names[0] : null;
    await pushToUser(userId, {
      title: "오늘 챙기셨나요?",
      body:
        who != null
          ? `${who} 아직 오늘 기록이 없어요. 점안·착용 후 체크해 주세요.`
          : "아직 오늘 기록이 없어요. 점안·착용 후 체크해 주세요.",
      path: "/children",
    });
    sent += 1;
  }
  return sent;
}

/** 진료 예정일·렌즈 교체일 하루 전. */
async function reminders(): Promise<number> {
  const { day, hour } = nowKST();
  // 하루 전 저녁에 한 번. 당일 아침에 알려 주면 이미 늦은 일정이 있다.
  if (hour !== 19) return 0;

  const tomorrow = new Date(day);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const rows = await prisma.child_reminder.findMany({
    where: { due_on: tomorrow, done_at: null },
    include: {
      parent_child_link: { select: { user_id: true, nickname: true } },
    },
  });
  if (rows.length === 0) return 0;

  const prefs = await prisma.notification_pref.findMany({
    where: { user_id: { in: rows.map((r) => r.parent_child_link.user_id) } },
    select: { user_id: true, reminder: true },
  });
  const off = new Set(prefs.filter((p) => !p.reminder).map((p) => p.user_id));

  let sent = 0;
  for (const r of rows) {
    const userId = r.parent_child_link.user_id;
    if (off.has(userId)) continue;
    // 자국은 일정마다 남긴다. 같은 날 일정이 둘이면 둘 다 알려야 한다.
    if (!(await claim(userId, `reminder:${r.id}`, day))) continue;
    const who = r.parent_child_link.nickname;
    const what = r.kind === "lens_replace" ? "렌즈 교체" : "진료";
    await pushToUser(userId, {
      title: `내일 ${what} 예정입니다`,
      body: [who, r.memo].filter(Boolean).join(" · ") || `내일 ${what} 일정이 있어요.`,
      path: "/children",
    });
    sent += 1;
  }
  return sent;
}

/**
 * 오래된 자국을 치운다.
 *
 * push_sent 는 보낼 때마다 한 줄씩 쌓이는데 쓰임새는 "오늘 보냈나" 하나다.
 * 어제 것도 다시 볼 일이 없으니 남겨 둘 이유가 없고, 안 치우면 사용자
 * 수 × 날수로 늘어난다.
 */
async function sweep(): Promise<void> {
  const { day } = nowKST();
  const cutoff = new Date(day);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  await prisma.push_sent.deleteMany({ where: { day: { lt: cutoff } } });
}

/** 한 시간에 한 번 불린다. */
export async function runPushReminders(): Promise<void> {
  try {
    await sweep();
    const [care, due] = await Promise.all([careDaily(), reminders()]);
    if (care > 0 || due > 0) {
      console.log(`[push] care=${care} reminder=${due}`);
    }
  } catch (err) {
    // 크론이 죽으면 다음 시각에도 안 돈다. 오류는 남기고 살려 둔다.
    console.error("[push] job failed", err);
  }
}
