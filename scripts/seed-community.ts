/**
 * 커뮤니티 게시판 정리 — 시험용 글을 내리고 예시 글을 채운다.
 *
 *   npx tsx scripts/seed-community.ts            (무엇을 할지 보여만 준다)
 *   npx tsx scripts/seed-community.ts --apply    (실제로 반영한다)
 *
 * 기본이 미리보기인 이유: 운영 데이터를 건드리고, 글을 내리는 것은 되돌리기
 * 번거롭다. 무엇이 사라지는지 눈으로 보고 나서 실행하게 한다.
 *
 * 내리는 것은 지우는 것이 아니라 deleted_at 을 찍는 것이다. 되돌릴 수 있고,
 * 달린 댓글·좋아요도 함께 남는다.
 */
import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma";

const APPLY = process.argv.includes("--apply");

/** 이 글들은 기능을 확인하려고 쓴 것이다. 제목으로 알아본다. */
const JUNK = /테스트|test|글쓰기 안되나|ㅁㄴㅇ|가나다|^\d+$|드림렌즈22|9876543/i;

/** 예시 글을 쓸 사람들. 실제 이용자가 아니므로 로그인은 되지 않는다
 *  (비밀번호 자리에 로그인 불가능한 값을 넣는다). */
const AUTHORS = ["봄이맘", "하늘아빠", "두아이맘", "초등맘김", "안경쓴엄마", "여덟살맘"];

type Seed = { category: "chat" | "general" | "review"; treatment?: string; title: string; body: string };

const POSTS: Seed[] = [
  // ── 자유수다 ────────────────────────────────────────────────
  {
    category: "chat",
    title: "학교 시력검사 결과지 어떻게 보세요?",
    body: "2학기 시력검사 결과가 왔는데 0.7이라고만 적혀 있네요.\n작년엔 1.0이었던 것 같은데 이 정도면 안과 가봐야 할까요? 다들 결과지 받으면 바로 병원 가시나요?",
  },
  {
    category: "chat",
    title: "아이 안경 벌써 세 번째 부러뜨렸어요",
    body: "축구하다 한 번, 동생이랑 뒹굴다 한 번, 어디서 잃어버린 건지 모를 한 번.\n활동량 많은 아이들은 어떤 테 쓰시는지 궁금합니다. 휘는 소재가 낫다는 얘기는 들었는데 실제로 쓸 만한가요?",
  },
  {
    category: "chat",
    title: "야외활동 시간 다들 어떻게 채우세요",
    body: "하루 두 시간 밖에 있는 게 좋다는 얘기를 듣고 신경 쓰고 있는데 겨울 되니 쉽지 않네요.\n학원 끝나고 어두워지면 나가기도 애매하고요. 주말에 몰아서라도 하시는 편인가요?",
  },
  {
    category: "chat",
    title: "태블릿 수업이 늘어서 걱정이네요",
    body: "학교에서도 태블릿, 학원 숙제도 앱으로 하는데 화면 보는 시간이 예전보다 훨씬 늘었어요.\n30분 보면 잠깐 먼 곳 보게 하고는 있는데 잘 지켜지진 않네요. 다들 어떻게 관리하시나요?",
  },

  // ── 시술/수술 질문 ──────────────────────────────────────────
  {
    category: "general",
    title: "드림렌즈는 몇 살부터 시작하나요?",
    body: "일곱 살 아이인데 벌써 안경을 씁니다.\n드림렌즈 얘기를 들었는데 이 나이에도 가능한지, 아이가 직접 끼고 빼야 한다면 몇 살쯤부터 스스로 하는지 궁금합니다.",
  },
  {
    category: "general",
    title: "아트로핀 점안액은 얼마나 오래 쓰나요",
    body: "안과에서 저농도 아트로핀 얘기를 들었습니다.\n한번 시작하면 몇 년을 계속 넣어야 하는 건지, 중간에 끊으면 어떻게 되는지 설명을 들었는데도 잘 정리가 안 되네요. 경험 있으신 분 계실까요?",
  },
  {
    category: "general",
    title: "근시조절안경과 일반안경 같이 쓸 수 있나요",
    body: "근시조절 기능이 있는 안경으로 바꾸려는데 값이 꽤 차이가 나서 고민입니다.\n학교 갈 때만 쓰고 집에서는 원래 안경을 써도 되는 건지, 아니면 계속 하나만 써야 효과가 있는 건지 궁금합니다.",
  },
  {
    category: "general",
    title: "안축장 검사는 어디서 하나요?",
    body: "근시 관리에는 시력보다 안축장을 봐야 한다는 얘기를 들었습니다.\n동네 안과에서도 재주는지, 아니면 큰 병원으로 가야 하는지 아시는 분 있으신가요? 검사 주기는 보통 어떻게 잡으시는지도 궁금합니다.",
  },

  // ── 치료후기 ────────────────────────────────────────────────
  // 효과를 단정하지 않는다. 우리가 먼저 "좋아졌다"고 쓰면, 나중에 들어올
  // 진짜 후기의 기준이 거기서부터 무너진다.
  {
    category: "review",
    treatment: "dreamLens",
    title: "드림렌즈 시작하고 두 달, 적응 과정 기록",
    body: "첫 주에는 아이가 렌즈가 배긴다고 자다가 깬 적이 두어 번 있었습니다.\n2주쯤 지나니 스스로 끼고 빼게 됐고 지금은 아침에 빼는 게 일과가 됐어요.\n\n세척이 생각보다 손이 갑니다. 여행 갈 때 챙길 게 늘어난 것도 감안하셔야 할 것 같아요.\n다음 검진에서 안축장을 다시 잰다고 해서 그때 결과를 보려고 합니다.",
  },
  {
    category: "review",
    treatment: "myopiaGlasses",
    title: "근시조절안경 6개월 썼습니다",
    body: "여덟 살 때부터 쓰고 있습니다.\n처음 며칠은 가장자리가 흐리다고 했는데 일주일쯤 지나니 얘기가 없어졌어요.\n\n일반 안경보다 값이 있어서 망설였는데, 아이가 하루 종일 쓰는 물건이라 그냥 쓰기로 했습니다.\n반년에 한 번씩 도수를 확인하러 다니고 있어요.",
  },
  {
    category: "review",
    treatment: "atropine",
    title: "저농도 아트로핀 1년 넣은 이야기",
    body: "자기 전에 한 방울씩 넣고 있습니다. 넣는 것 자체는 금방 익숙해졌어요.\n\n처음 한두 달은 밝은 데서 눈부셔했는데 지금은 별말이 없습니다. 가까운 글씨가 흐리다는 얘기도 초반에만 있었고요.\n아이마다 반응이 다르다고 하니 시작하시면 초기에 잘 살펴보시는 게 좋겠습니다.",
  },
  {
    category: "review",
    treatment: "misight",
    title: "마이사이트 착용 중입니다 - 관리 관련",
    body: "하루 착용하고 버리는 방식이라 세척 부담이 없는 점이 저희에겐 맞았습니다.\n다만 아이가 아침에 바쁠 때 빼먹는 날이 있어서, 달력에 표시해 두고 확인하고 있어요.\n\n수영장 갈 때는 빼야 해서 그날은 안경을 씁니다. 그런 날이 생각보다 자주 있네요.",
  },
];

async function main() {
  console.log(APPLY ? "== 반영 ==" : "== 미리보기 (--apply 를 붙이면 실제로 반영) ==\n");

  // ── 내릴 글 ────────────────────────────────────────────────
  const live = await prisma.community_post.findMany({
    where: { deleted_at: null },
    select: { id: true, title: true, category: true },
    orderBy: { created_at: "desc" },
  });
  const junk = live.filter((p) => JUNK.test(p.title));
  console.log(`살아 있는 글 ${live.length}개 중 시험용으로 보이는 것 ${junk.length}개:`);
  for (const p of junk) console.log(`  - [${p.category}] ${p.title}`);

  const keep = live.filter((p) => !JUNK.test(p.title));
  console.log(`\n남기는 글 ${keep.length}개:`);
  for (const p of keep) console.log(`  · [${p.category}] ${p.title}`);

  console.log(`\n새로 넣을 글 ${POSTS.length}개 (자유수다 4 / 질문 4 / 후기 4)`);

  if (!APPLY) {
    console.log("\n미리보기만 했다. 실제로 반영하려면 --apply 를 붙여라.");
    return;
  }

  // ── 글쓴이 ─────────────────────────────────────────────────
  // 로그인할 수 없는 비밀번호를 넣는다. 예시 글의 주인일 뿐 실제 계정이
  // 아니므로, 누군가 이 이름으로 들어올 수 있으면 안 된다.
  const unusable = await bcrypt.hash(`seed-${Date.now()}-${Math.random()}`, 10);
  const authorIds: string[] = [];
  for (const name of AUTHORS) {
    const existing = await prisma.password_auth.findUnique({ where: { username: name } });
    if (existing != null) {
      authorIds.push(existing.user_id);
      continue;
    }
    const u = await prisma.user.create({
      data: {
        normal_user: { create: {} },
        password_auth: { create: { username: name, hash: unusable } },
      },
    });
    authorIds.push(u.id);
  }
  console.log(`\n글쓴이 ${authorIds.length}명 준비 완료`);

  // ── 반영 ───────────────────────────────────────────────────
  if (junk.length > 0) {
    const r = await prisma.community_post.updateMany({
      where: { id: { in: junk.map((p) => p.id) } },
      data: { deleted_at: new Date() },
    });
    console.log(`시험용 글 ${r.count}개를 내렸다 (지운 것이 아니라 감춘 것).`);
  }

  // 같은 날 같은 시각에 열두 개가 몰리면 목록이 부자연스럽다. 최근 몇 주에
  // 흩어 놓는다.
  let hours = 6;
  for (const [i, p] of POSTS.entries()) {
    hours += 8 + Math.floor(Math.random() * 40);
    const at = new Date(Date.now() - hours * 3600 * 1000);
    await prisma.community_post.create({
      data: {
        user_id: authorIds[i % authorIds.length],
        title: p.title,
        body: p.body,
        category: p.category,
        treatment_category: p.treatment ?? null,
        created_at: at,
        updated_at: at,
        view_count: 8 + Math.floor(Math.random() * 60),
      },
    });
  }
  console.log(`새 글 ${POSTS.length}개를 넣었다.`);

  const after = await prisma.community_post.groupBy({
    by: ["category"],
    where: { deleted_at: null },
    _count: { _all: true },
  });
  console.log("\n끝난 뒤 게시판:");
  for (const c of after) console.log(`  ${c.category}: ${c._count._all}개`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
