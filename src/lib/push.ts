import prisma from "./prisma";

/**
 * 폰으로 알림을 보낸다.
 *
 * Expo 푸시 서비스를 거친다. 애플(APNs)과 구글(FCM)에 각각 붙으려면 인증서와
 * 키를 따로 들고 있어야 하는데, 앱이 이미 Expo 위에 있어 그 일을 Expo 가
 * 대신해 준다.
 *
 * 여기서 나는 오류는 전부 삼킨다. 알림은 사용자가 실제로 요청한 일의
 * 곁가지라, 못 보냈다고 댓글 달기가 실패하면 안 된다. notify() 가 같은
 * 이유로 그렇게 하고 있다.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Expo 가 한 번에 받는 개수. 이보다 많으면 나눠 보낸다. */
const CHUNK = 100;

export type PushMessage = {
  title: string;
  body: string;
  /** 눌렀을 때 앱이 어디로 갈지. 앱이 그대로 라우터에 넘긴다. */
  path?: string;
  data?: Record<string, unknown>;
};

/** 보낼 값이 하나라도 이상하면 Expo 가 그 묶음 전체를 거절한다. */
function isExpoToken(t: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
}

async function postChunk(messages: unknown[]): Promise<void> {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    console.error("[push] expo rejected", res.status, await res.text().catch(() => ""));
    return;
  }
  const body = (await res.json().catch(() => null)) as
    | { data?: { status: string; message?: string; details?: { error?: string } }[] }
    | null;
  const tickets = body?.data ?? [];

  // 기기에 앱이 지워졌으면 Expo 가 DeviceNotRegistered 로 알려 준다. 그
  // 토큰을 남겨 두면 보낼 때마다 실패가 쌓이고, 그 사람이 다시 깔아
  // 로그인해도 옛 토큰이 먼저 잡힌다.
  const dead: string[] = [];
  tickets.forEach((t, i) => {
    if (t.status === "error" && t.details?.error === "DeviceNotRegistered") {
      const m = messages[i] as { to?: string };
      if (typeof m?.to === "string") dead.push(m.to);
    }
  });
  if (dead.length > 0) {
    await prisma.push_token.deleteMany({ where: { token: { in: dead } } });
  }
}

/** 이 사람의 모든 기기로. 토큰이 없으면 조용히 넘어간다. */
export async function pushToUser(userId: string, msg: PushMessage): Promise<void> {
  await pushToUsers([userId], msg);
}

/** 여러 사람에게 같은 내용을. 크론이 쓴다. */
export async function pushToUsers(userIds: string[], msg: PushMessage): Promise<void> {
  try {
    if (userIds.length === 0) return;
    const rows = await prisma.push_token.findMany({
      where: { user_id: { in: userIds } },
      select: { token: true },
    });
    const tokens = rows.map((r) => r.token).filter(isExpoToken);
    if (tokens.length === 0) return;

    const messages = tokens.map((to) => ({
      to,
      title: msg.title,
      body: msg.body,
      sound: "default",
      // 눌렀을 때 갈 곳을 함께 싣는다. 알림 목록으로만 보내면 방금 읽은
      // 그 알림을 목록에서 다시 찾아 눌러야 한다.
      data: { path: msg.path, ...msg.data },
    }));

    for (let i = 0; i < messages.length; i += CHUNK) {
      await postChunk(messages.slice(i, i + CHUNK));
    }
  } catch (err) {
    console.error("[push] failed", err);
  }
}

/**
 * 이 사람이 그 종류를 받기로 했나.
 *
 * 줄이 없으면 받는 것으로 본다. 기존 사용자에게 기본값 줄을 미리 만들어
 * 두지 않아도 되고, 나중에 항목이 늘어도 예전 줄이 막지 않는다.
 */
export async function wantsPush(
  userId: string,
  kind: "community" | "care_daily" | "reminder",
): Promise<boolean> {
  const pref = await prisma.notification_pref.findUnique({
    where: { user_id: userId },
    select: { community: true, care_daily: true, reminder: true },
  });
  if (pref == null) return true;
  return pref[kind];
}
