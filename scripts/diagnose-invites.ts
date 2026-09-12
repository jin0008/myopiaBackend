/**
 * 병원이 만든 연동 초대 링크가 어떻게 됐는지 본다.
 *
 * "링크를 만들어 보냈는데 연동이 안 된다"는 문의는 원인이 여럿이다 -
 * 링크가 아예 안 만들어졌는지, 다른 주소로 갔는지, 이미 썼는지, 기한이
 * 지났는지, 받은 사람이 열긴 했는지. 초대 표 자체를 보면 바로 갈린다.
 *
 *   npx tsx scripts/diagnose-invites.ts            최근 20건
 *   npx tsx scripts/diagnose-invites.ts 50         최근 50건
 *   npx tsx scripts/diagnose-invites.ts 20 한진우   그 사람이 만든 것만
 *
 * 읽기만 한다.
 */
import prisma from "../src/lib/prisma";
import { decryptSymmetric } from "../src/services/encrpytion";

const takeArg = Number.parseInt(process.argv[2] ?? "", 10);
const take = Number.isFinite(takeArg) && takeArg > 0 ? takeArg : 20;
const creatorQuery = process.argv[3] ?? null;

function when(d: Date | null): string {
  return d == null ? "-" : d.toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
  const rows = await prisma.child_link_invite.findMany({
    orderBy: { created_at: "desc" },
    take,
    include: {
      hospital: { select: { name: true, code: true } },
      creator: { select: { email: true } },
      user: { select: { email: true } },
      patient: { select: { id: true, sex: true, encrypted_date_of_birth: true } },
    },
  });

  const filtered =
    creatorQuery == null
      ? rows
      : rows.filter((r) => (r.creator?.email ?? "").includes(creatorQuery));

  if (filtered.length === 0) {
    console.log("\n초대 기록이 없습니다.");
    console.log("→ 병원 화면에서 '연동하기'를 눌렀을 때 링크가 실제로");
    console.log("  만들어지지 않았다는 뜻입니다. 그쪽(myopia)부터 봐야 합니다.\n");
    return;
  }

  console.log(`\n최근 초대 ${filtered.length}건 (새 것부터)\n`);
  for (const r of filtered) {
    const dob = (await decryptSymmetric(r.patient.encrypted_date_of_birth)).slice(
      0,
      10,
    );
    const expired = r.expires_at.getTime() < Date.now();
    const state = r.revoked_at
      ? "취소됨"
      : r.used_at
        ? "사용됨(연동 완료)"
        : expired
          ? "기한 지남"
          : "아직 안 씀";

    console.log(`- ${when(r.created_at)}  [${state}]`);
    console.log(`    병원      ${r.hospital.name} (${r.hospital.code})`);
    console.log(`    환자      ${dob} / ${r.patient.sex} / ${r.patient.id}`);
    console.log(`    만든 사람 ${r.creator?.email ?? "(주소 없음)"}`);
    console.log(`    보낸 곳   ${r.sent_to ?? "(메일 발송 안 함 / 주소 미기록)"}`);
    console.log(`    기한      ${when(r.expires_at)}${expired ? "  ← 지남" : ""}`);
    if (r.used_at) {
      console.log(`    쓴 사람   ${r.user?.email ?? r.used_by} (${when(r.used_at)})`);
    }

    // 이 환자와 이미 이어진 자녀가 있는지. 있으면 링크를 다시 눌러도
    // 중복으로 거절된다.
    const links = await prisma.child_hospital_link.findMany({
      where: { patient_id: r.patient_id },
      select: { parent_child_link_id: true, status: true },
    });
    if (links.length > 0) {
      console.log(
        `    ※ 이 환자는 이미 자녀 ${links.length}건과 연동돼 있습니다 ` +
          `(다시 이으려 하면 중복으로 거절됩니다)`,
      );
    }
    console.log();
  }

  console.log("읽는 법");
  console.log("  '아직 안 씀' + 보낸 곳이 비어 있음 → 메일이 안 나갔습니다.");
  console.log("  '아직 안 씀' + 주소가 보호자 것이 아님 → 다른 데로 갔습니다.");
  console.log("  '아직 안 씀' + 주소가 맞음 → 보호자가 아직 안 열었거나,");
  console.log("     열었지만 고를 수 있는 자녀가 없어 수락까지 못 갔습니다.");
  console.log("  '사용됨' → 연동은 끝났습니다. 안 보인다면 다른 문제입니다.\n");
}

main()
  .catch((e) => {
    console.error("\n진단 중 오류:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
