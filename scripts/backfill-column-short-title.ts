/**
 * 기존 칼럼에 짧은 제목을 채운다.
 *
 *   npx tsx scripts/backfill-column-short-title.ts            (미리보기)
 *   npx tsx scripts/backfill-column-short-title.ts --apply
 *
 * 홈 카드는 두 줄이다. 본문에서 친절한 긴 제목이 거기서는 따옴표와 기호만
 * 빽빽해 무슨 글인지 안 읽힌다. 짧은 쪽은 "무엇에 대한 글인가"만 남긴다.
 *
 * 이미 채워진 것은 건드리지 않는다 - 운영자가 손으로 고친 것을 덮으면
 * 스크립트를 다시 돌릴 때마다 되돌아간다.
 */
import prisma from "../src/lib/prisma";

const APPLY = process.argv.includes("--apply");

/** 원래 제목 → 카드에 쓸 제목. 제목이 바뀐 칼럼은 그냥 건너뛴다. */
const SHORT: Record<string, string> = {
  '에실로 "스텔리스트 2"는 "스텔리스트 1"과 뭐가 달라요?': "스텔리스트 2, 뭐가 다를까",
  "드림렌즈 브랜드 파헤치기 ② 국산도 있다! - 루시드코리아 렌즈":
    "드림렌즈 브랜드 ② 루시드코리아",
  "드림렌즈 브랜드 파헤치기 ① — 파라곤 CRT(Paragon CRT)":
    "드림렌즈 브랜드 ① 파라곤 CRT",
  "드림렌즈, 아무나 낄 수 있는 게 아니에요 — 처방 가능한 도수와 각막 기준":
    "드림렌즈, 누가 낄 수 있나",
  "드림렌즈(OK렌즈), 끼고 자도 문제 없을까요?": "드림렌즈, 끼고 자도 괜찮을까",
  "책 가까이 보면 눈 나빠진다는 말, 진짜일까요? — 근거리 작업과 근시":
    "가까이 보면 눈이 나빠질까",
  "마이오스마트, 스텔리스트 안경 이렇게 쓰면 안되요!": "근시조절안경, 이렇게 쓰면 안 돼요",
  "아트로핀 치료하는데도 계속 나빠져요!!": "아트로핀 쓰는데 계속 나빠져요",
  "마이사이트 - 오래 사용해도 안전할까요?": "마이사이트, 오래 써도 될까",
  "우리 아이 눈이 빠르게 나빠지는 건가요? (근시 진행 속도)": "근시가 빠르게 나빠지는 걸까",
  "당근 & 결명자차, 눈에 정말 좋을까요? 🥕🍵": "당근과 결명자차, 눈에 좋을까",
  "하루 2시간이면 충분해요, 근시를 늦추는 가장 쉽고도 어려운 방법":
    "하루 2시간 바깥 활동",
  "우리 아이 시력이 너무 나빠서 마이너스에요!!": "시력이 마이너스라는 말",
  "마이오스마트와 마이오스마트 iQ, 뭐가 달라졌을까요?": "마이오스마트 iQ, 뭐가 달라졌나",
  "드림렌즈, 우리 아이한테 맞을까요? 장단점 완벽정리": "드림렌즈 장단점 정리",
  "근시 치료, 언제 멈춰야 할까요?": "근시 치료, 언제 멈출까",
  "근시 치료, 언제부터 시작해야 할까요?": "근시 치료, 언제 시작할까",
  "증후군성 근시 이야기 - 근시와 함께 전신에 문제가 발생하는 경우":
    "증후군성 근시 이야기",
  "마이오가드, 정말 근시 진행을 늦춰줄까요? — 국내 연구 2편으로 알아봐요":
    "마이오가드, 정말 효과 있을까",
  "아트로핀 사용하다 끊으면 더 나빠지나요? (리바운드효과, 반동효과)":
    "아트로핀 끊으면 더 나빠질까",
};

async function main() {
  console.log(APPLY ? "== 반영 ==" : "== 미리보기 (--apply 를 붙이면 반영) ==\n");
  const rows = await prisma.expert_column.findMany({
    select: { id: true, title: true, short_title: true },
    orderBy: { published_at: "desc" },
  });

  let done = 0;
  let skipped = 0;
  let unknown = 0;
  for (const r of rows) {
    if (r.short_title != null && r.short_title !== "") {
      skipped += 1;
      continue;
    }
    const short = SHORT[r.title];
    if (short == null) {
      console.log(`  ? 짧은 제목 없음: ${r.title}`);
      unknown += 1;
      continue;
    }
    console.log(`  ${r.title}\n    → ${short}`);
    if (APPLY) {
      await prisma.expert_column.update({
        where: { id: r.id },
        data: { short_title: short, updated_at: new Date() },
      });
    }
    done += 1;
  }
  console.log(
    `\n칼럼 ${rows.length}편 · 채움 ${done} · 이미 있어 건너뜀 ${skipped} · 목록에 없음 ${unknown}`,
  );
  if (!APPLY) console.log("미리보기만 했다. 반영하려면 --apply.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
