/**
 * 시험용 글 판별이 맞는지 본다.
 *
 *   npx tsx scripts/check-seed-junk.ts
 *
 * 이 판별이 틀리면 멀쩡한 글이 내려간다. 운영 목록에서 실제로 본 제목들로
 * 확인한다.
 */
import assert from "assert";

const JUNK = /테스트|test|글쓰기 안되나|ㅁㄴㅇ|가나다|^\d+$|드림렌즈22|9876543/i;

// 운영에 실제로 있던 제목들
const shouldDrop = [
  "테스트",
  "글쓰기 안되나",
  "기타치료 9876543",
  "근시조절 안경 테스트",
  "라식 라섹 테스트",
  "자유수다 테스트",
  "드림렌즈22",
  "치료후기 종류별로 잘 나옵니다".replace("잘 나옵니다", "테스트"),
];
const shouldKeep = [
  "드림렌즈 후기",
  "근시조절안경",
  "시술/수술 질문",
  "저농도 아트로핀",
  "자유수다",
  "일반 안경은 흐리게 보이는 것을 선명하게 교정해 줄 뿐, 근시가 진행하는 속도를",
  // 새로 넣는 글이 스스로 걸리면 안 된다
  "드림렌즈 시작하고 두 달, 적응 과정 기록",
  "근시조절안경 6개월 썼습니다",
  "학교 시력검사 결과지 어떻게 보세요?",
  "드림렌즈는 몇 살부터 시작하나요?",
];

for (const t of shouldDrop) assert.ok(JUNK.test(t), `내려야 하는데 안 걸린다: ${t}`);
for (const t of shouldKeep) assert.ok(!JUNK.test(t), `남겨야 하는데 걸린다: ${t}`);

console.log(`ok — 시험용 ${shouldDrop.length}개를 걸러내고, 남길 ${shouldKeep.length}개는 건드리지 않는다`);
