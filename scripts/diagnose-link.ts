/**
 * 병원 연동이 왜 거부됐는지 찍어 본다.
 *
 * 연동 API 는 서로 다른 이유로 똑같은 "no matching record" 를 낸다 - 병원
 * 코드가 틀렸는지, 등록번호가 없는지, 생년월일이 어긋나는지, 아예 연동
 * 대상이 아닌 자녀인지 밖에서는 구분할 수 없다. 여기서는 하나씩 따로
 * 확인해 어디서 막혔는지 말해 준다.
 *
 *   npx tsx scripts/diagnose-link.ts <보호자이메일> [병원코드] [등록번호]
 *
 * 등록번호를 모르면 뒤 두 개를 빼고 보호자 계정 상태만 볼 수도 있다.
 */
import { prisma } from "../src/lib/prisma";
import { hashRegistrationNumber } from "../src/lib/hash";
import { decryptSymmetric } from "../src/services/encrpytion";

const [email, hospitalCode, registrationNumber] = process.argv.slice(2);

const ok = (s: string) => console.log("  [OK] " + s);
const bad = (s: string) => console.log("  [!!] " + s);
const info = (s: string) => console.log("       " + s);

async function main() {
  if (!email) {
    console.log(
      "사용법: npx tsx scripts/diagnose-link.ts <보호자이메일> [병원코드] [등록번호]",
    );
    return;
  }

  console.log("\n[1] 보호자 계정");
  const user = await prisma.user.findUnique({ where: { email } });
  if (user == null) {
    bad(`${email} 로 가입한 계정이 없습니다.`);
    info("앱에서 가입할 때 쓴 주소가 맞는지 확인하세요.");
    info("소셜 로그인은 앱에 보이는 주소와 다를 수 있습니다.");
    return;
  }
  ok(`user ${user.id}`);
  const hcp = await prisma.healthcare_professional.findUnique({
    where: { user_id: user.id },
  });
  if (hcp != null) {
    info("※ 이 계정은 의료진 계정이기도 합니다. 아래 [2] 를 특히 잘 보세요.");
  }

  console.log("\n[2] 이 계정의 자녀 목록");
  const appChildren = await prisma.parent_child_link.findMany({
    where: { user_id: user.id },
  });
  const webChildren = await prisma.user_patient.findMany({
    where: { user_id: user.id },
  });
  console.log(`  앱에서 등록한 자녀(연동 가능): ${appChildren.length}명`);
  for (const c of appChildren) {
    const dob = c.date_of_birth.toISOString().slice(0, 10);
    info(`- ${c.nickname ?? "(애칭 없음)"} / ${dob} / ${c.sex} / id=${c.id}`);
  }
  console.log(`  웹에서 넘어온 자녀(연동 불가): ${webChildren.length}명`);
  for (const w of webChildren) {
    info(`- patient ${w.patient_id}`);
  }
  if (appChildren.length === 0 && webChildren.length > 0) {
    bad("앱에서 등록한 자녀가 없습니다. 이것만으로 두 연동 방법이 모두 막힙니다.");
    info("연동 API 는 앱에서 직접 등록한 자녀만 받습니다");
    info("(loadOwnedChild 가 source !== 'app' 을 걸러 404 를 냅니다).");
    info("웹에서 넘어온 자녀는 이미 그 환자와 이어져 있어 다시 이을 대상이 아닙니다.");
    info("→ 앱에서 '자녀 추가'로 새로 등록한 뒤 연동해 보세요.");
  }

  if (!hospitalCode || !registrationNumber) {
    console.log("\n(병원코드·등록번호를 주시면 [3] 부터 이어서 확인합니다)\n");
    return;
  }

  console.log("\n[3] 병원 코드");
  const hospital = await prisma.hospital.findUnique({
    where: { code: hospitalCode },
  });
  if (hospital == null) {
    bad(`code='${hospitalCode}' 인 병원이 없습니다.`);
    const some = await prisma.hospital.findMany({
      take: 10,
      select: { code: true, name: true },
    });
    info("등록된 병원 예시: " + some.map((h) => `${h.code}(${h.name})`).join(", "));
    return;
  }
  ok(`${hospital.name} (id=${hospital.id})`);

  console.log("\n[4] 등록번호로 환자 찾기");
  const patient = await prisma.patient.findUnique({
    where: {
      registration_number_hash_hospital_id: {
        registration_number_hash: hashRegistrationNumber(
          registrationNumber.trim(),
        ),
        hospital_id: hospital.id,
      },
    },
  });
  if (patient == null) {
    bad(`이 병원에 등록번호 '${registrationNumber}' 인 환자가 없습니다.`);
    info("등록번호는 해시로 대조합니다 - 앞의 0, 공백, 하이픈까지");
    info("병원에 입력된 것과 글자 하나까지 같아야 합니다.");
    return;
  }
  ok(`patient ${patient.id} / 성별 ${patient.sex}`);

  console.log("\n[5] 생년월일·성별 대조");
  const dob = (await decryptSymmetric(patient.encrypted_date_of_birth)).slice(
    0,
    10,
  );
  info(`환자(병원) : ${dob} / ${patient.sex}`);
  let matched = false;
  for (const c of appChildren) {
    const cd = c.date_of_birth.toISOString().slice(0, 10);
    const same = cd === dob && c.sex === patient.sex;
    const line = `자녀 '${c.nickname ?? c.id}' : ${cd} / ${c.sex}`;
    if (same) {
      ok(line + " → 일치");
      matched = true;
    } else {
      bad(line + " → 불일치");
    }
  }
  if (!matched) {
    bad("일치하는 자녀가 없습니다. 생년월일이나 성별이 어긋납니다.");
  }

  console.log("\n[6] 이미 연동돼 있는지");
  const existing = await prisma.child_hospital_link.findMany({
    where: { hospital_id: hospital.id, patient_id: patient.id },
  });
  if (existing.length > 0) {
    bad(`이미 연동된 기록이 ${existing.length}건 있습니다.`);
    for (const e of existing) {
      info(`- parent_child_link=${e.parent_child_link_id} status=${e.status}`);
    }
    info("같은 자녀-병원 조합은 한 번만 이을 수 있어, 다시 누르면 409 로 거부됩니다.");
  } else {
    ok("아직 연동된 기록이 없습니다.");
  }
  console.log();
}

main()
  .catch((e) => {
    console.error("\n진단 중 오류:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
