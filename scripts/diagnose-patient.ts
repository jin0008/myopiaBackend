/**
 * 이 환자가 왜 삭제되지 않는지 본다.
 *
 * 환자를 참조하는 표는 대부분 함께 지워지도록(CASCADE) 걸려 있는데
 * child_hospital_link 하나만 막도록(NO ACTION) 되어 있다. 그래서 보호자
 * 앱과 연동된 환자는 삭제가 거부되고, 화면에는 이유 없이 실패만 뜬다.
 *
 *   npx tsx scripts/diagnose-patient.ts <병원코드> <등록번호>
 *   npx tsx scripts/diagnose-patient.ts --id <환자 UUID>
 *
 * 읽기만 한다.
 */
import prisma from "../src/lib/prisma";
import { hashRegistrationNumber } from "../src/lib/hash";
import { decryptSymmetric } from "../src/services/encrpytion";

const ok = (s: string) => console.log("  [OK] " + s);
const bad = (s: string) => console.log("  [!!] " + s);
const info = (s: string) => console.log("       " + s);

async function findPatient() {
  const a = process.argv.slice(2);
  if (a[0] === "--id" && a[1]) {
    return prisma.patient.findUnique({ where: { id: a[1] } });
  }
  const [code, reg] = a;
  if (!code || !reg) return null;
  const hospital = await prisma.hospital.findUnique({ where: { code } });
  if (hospital == null) {
    bad(`code='${code}' 인 병원이 없습니다.`);
    const some = await prisma.hospital.findMany({
      take: 10,
      select: { code: true, name: true },
    });
    info("등록된 병원: " + some.map((h) => `${h.code}(${h.name})`).join(", "));
    return null;
  }
  return prisma.patient.findUnique({
    where: {
      registration_number_hash_hospital_id: {
        registration_number_hash: hashRegistrationNumber(reg.trim()),
        hospital_id: hospital.id,
      },
    },
  });
}

async function main() {
  if (process.argv.length < 4) {
    console.log(
      "사용법: npx tsx scripts/diagnose-patient.ts <병원코드> <등록번호>",
    );
    console.log("        npx tsx scripts/diagnose-patient.ts --id <환자 UUID>");
    return;
  }

  console.log("\n[1] 환자");
  const patient = await findPatient();
  if (patient == null) {
    bad("해당 환자를 찾지 못했습니다.");
    info("등록번호는 해시로 대조합니다 - 앞의 0, 공백, 하이픈까지 같아야 합니다.");
    return;
  }
  const hospital = await prisma.hospital.findUnique({
    where: { id: patient.hospital_id },
    select: { name: true, code: true },
  });
  const dob = (await decryptSymmetric(patient.encrypted_date_of_birth)).slice(0, 10);
  ok(`${patient.id}`);
  info(`소속 병원  ${hospital?.name} (${hospital?.code})`);
  info(`생년월일   ${dob} / ${patient.sex}`);

  console.log("\n[2] 삭제를 막는 것 — 보호자 앱 연동");
  const links = await prisma.child_hospital_link.findMany({
    where: { patient_id: patient.id },
    include: {
      hospital: { select: { name: true, code: true } },
      parent_child_link: {
        select: { id: true, nickname: true, user: { select: { email: true } } },
      },
    },
  });
  if (links.length === 0) {
    ok("연동 없음 — 이것 때문에 막히는 것은 아닙니다.");
  } else {
    bad(`연동 ${links.length}건 — 이것 때문에 삭제가 거부됩니다.`);
    for (const l of links) {
      info(
        `- ${l.parent_child_link.nickname ?? "(애칭 없음)"} / ` +
          `${l.parent_child_link.user.email ?? "(주소 없음)"} / ` +
          `${l.hospital.name} / 연동 ${l.linked_at.toISOString().slice(0, 10)}`,
      );
    }
    info("병원 화면의 '연동하기'에서 해제하면 삭제됩니다(관리자만).");
  }

  console.log("\n[3] 함께 지워지는 것들 (막지 않음)");
  const [mirrors, measurements, invites] = await Promise.all([
    prisma.user_patient.count({ where: { patient_id: patient.id } }),
    prisma.measurement.count({ where: { patient_id: patient.id } }),
    prisma.child_link_invite.count({ where: { patient_id: patient.id } }),
  ]);
  info(`user_patient(웹 자녀 미러) ${mirrors}건`);
  info(`measurement(측정)          ${measurements}건`);
  info(`child_link_invite(초대)    ${invites}건`);

  console.log("\n[4] 결론");
  if (links.length === 0) {
    ok("지금 상태라면 삭제가 됩니다. 실패한다면 다른 원인입니다.");
    info("서버 로그(journalctl -u myopia)에서 실제 오류를 봐야 합니다.");
  } else {
    bad("연동을 먼저 해제해야 삭제됩니다.");
  }
  console.log();
}

main()
  .catch((e) => {
    console.error("\n진단 중 오류:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
