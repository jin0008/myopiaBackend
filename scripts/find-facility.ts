/**
 * 광고를 걸 업체의 번호를 찾는다.
 *
 * 어드민에서 유료 노출을 등록할 때 요양기호(안과)나 인허가번호(안경점)를
 * 넣어야 하는데, 업체가 그 번호를 알고 있을 리 없다. 상호로 찾아 준다.
 *
 *   npx tsx scripts/find-facility.ts <상호 일부> [지역]
 *
 * 예) npx tsx scripts/find-facility.ts 파피루스
 *     npx tsx scripts/find-facility.ts 안경 중구
 *
 * 읽기만 한다.
 */
import prisma from "../src/lib/prisma";

const [name, area] = process.argv.slice(2);

async function main() {
  if (!name) {
    console.log("사용법: npx tsx scripts/find-facility.ts <상호 일부> [지역]");
    return;
  }

  const where = (addrField: "address") => ({
    name: { contains: name, mode: "insensitive" as const },
    ...(area ? { [addrField]: { contains: area } } : {}),
  });

  const clinics = await prisma.eye_clinic.findMany({
    where: where("address"),
    select: { ykiho: true, name: true, address: true, kind: true },
    take: 30,
    orderBy: { name: "asc" },
  });
  const shops = await prisma.optical_shop.findMany({
    where: where("address"),
    select: { license_no: true, name: true, address: true },
    take: 30,
    orderBy: { name: "asc" },
  });

  if (clinics.length > 0) {
    console.log(`\n[안과] ${clinics.length}곳  — 어드민 '구분: 안과' + 아래 요양기호`);
    for (const c of clinics) {
      console.log(`  ${c.ykiho.padEnd(14)} ${c.name}`);
      console.log(`  ${" ".repeat(14)} ${c.address}`);
    }
  }
  if (shops.length > 0) {
    console.log(`\n[안경점] ${shops.length}곳  — 어드민 '구분: 안경점' + 아래 인허가번호`);
    for (const s of shops) {
      console.log(`  ${s.license_no.padEnd(26)} ${s.name}`);
      console.log(`  ${" ".repeat(26)} ${s.address}`);
    }
  }
  if (clinics.length === 0 && shops.length === 0) {
    console.log("\n찾지 못했습니다. 상호 일부만 넣어 보세요(예: '파피루스').");
  }

  // 이미 광고가 걸린 곳은 알려 준다. 모르고 다시 등록하면 기간이 덮인다.
  const keys = [...clinics.map((c) => c.ykiho), ...shops.map((s) => s.license_no)];
  if (keys.length > 0) {
    const promos = await prisma.facility_promotion.findMany({
      where: { key: { in: keys } },
      select: { kind: true, key: true, starts_at: true, ends_at: true },
    });
    if (promos.length > 0) {
      console.log("\n[이미 등록된 광고]");
      for (const p of promos) {
        console.log(
          `  ${p.key}  ${p.starts_at.toISOString().slice(0, 10)} ~ ${p.ends_at
            .toISOString()
            .slice(0, 10)}`,
        );
      }
      console.log("  같은 번호로 다시 저장하면 기간이 덮어써집니다.");
    }
  }
  console.log();
}

main()
  .catch((e) => {
    console.error("\n조회 중 오류:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
