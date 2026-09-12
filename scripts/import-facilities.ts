/**
 * 전국 안과·안경점 명부를 CSV 에서 읽어 넣는다.
 *
 *   npx tsx scripts/import-facilities.ts
 *
 * 같은 기관은 요양기호(안과)·인허가 관리번호(안경점)로 알아보고 덮어쓴다.
 * 자료가 갱신되면 CSV 만 바꾸고 다시 돌리면 된다.
 *
 * 지워진 곳은 건드리지 않는다. 폐업을 명부에서 지우려면 그 판단이 자료
 * 안에 있어야 하는데, 지금 파일은 영업 중인 곳만 담고 있어 "빠졌다"와
 * "이번 파일에 안 들어왔다"를 구분할 수 없다.
 */
import fs from "fs";
import path from "path";

import prisma from "../src/lib/prisma";
import { parseCsv } from "../src/lib/csv";
import { areaCodeFor, normalizePhone } from "../src/lib/phone";

const DIR = path.join(__dirname, "../src/assets/facilities");


/** "서울특별시 강남구 ..." 에서 지역번호를 고른다. */
function areaFromAddress(addr: string): string | null {
  const m = /^(\S+?(?:특별시|광역시|특별자치시|특별자치도|도))\s+(\S+)/.exec(addr ?? "");
  if (m == null) return null;
  const sido = m[1]
    .replace(/(특별시|광역시|특별자치시|특별자치도)$/, "")
    .replace(/^(강원|전북|제주)특별자치도$/, "$1")
    .replace(/도$/, "");
  const short =
    { 서울: "서울", 부산: "부산", 대구: "대구", 인천: "인천", 광주: "전남광주",
      대전: "대전", 울산: "울산", 세종: "세종", 경기: "경기", 강원: "강원",
      충청북: "충북", 충청남: "충남", 전라북: "전북", 전라남: "전남",
      경상북: "경북", 경상남: "경남", 제주: "제주" }[sido] ?? sido;
  return areaCodeFor(short, m[2]);
}

function int(v: string): number | null {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const clinics = parseCsv(fs.readFileSync(path.join(DIR, "eye_clinics.csv"), "utf8"));
  console.log(`안과 ${clinics.length}곳`);
  let n = 0;
  for (const c of clinics) {
    const data = {
      name: c.name,
      kind: c.kind,
      sido: c.sido,
      sigungu: c.sigungu,
      address: c.address,
      // 자료의 번호는 제각각이다. 한 모양으로 맞추되 지역번호는 확신이
      // 설 때만 붙인다(lib/phone.ts).
      phone: normalizePhone(c.phone || null, areaCodeFor(c.sido, c.sigungu)),
      homepage: c.homepage || null,
      lat: Number(c.lat),
      lng: Number(c.lng),
      doctors: int(c.doctors),
      eye_doctors: int(c.eyeDoctors),
      opened_on: c.openedOn || null,
      hours: c.hours ? (JSON.parse(c.hours) as object) : undefined,
      lunch: c.lunch || null,
      recv: c.recv || null,
      place: c.place || null,
      updated_at: new Date(),
    };
    await prisma.eye_clinic.upsert({
      where: { ykiho: c.ykiho },
      create: { ykiho: c.ykiho, ...data },
      update: data,
    });
    if (++n % 500 === 0) console.log(`  ${n}`);
  }

  const shops = parseCsv(fs.readFileSync(path.join(DIR, "optical_shops.csv"), "utf8"));
  console.log(`안경점 ${shops.length}곳`);
  n = 0;
  for (const s of shops) {
    const data = {
      name: s.name,
      address: s.address,
      // 안경점 자료에는 시도 칸이 없어 주소 앞머리로 가른다.
      phone: normalizePhone(s.phone || null, areaFromAddress(s.address)),
      lat: Number(s.lat),
      lng: Number(s.lng),
      refractometer: int(s.refractometer) ?? 0,
      eye_chart: int(s.eyeChart) ?? 0,
      licensed_on: s.licensedOn || null,
      updated_at: new Date(),
    };
    await prisma.optical_shop.upsert({
      where: { license_no: s.licenseNo },
      create: { license_no: s.licenseNo, ...data },
      update: data,
    });
    if (++n % 1000 === 0) console.log(`  ${n}`);
  }

  const [a, b] = await Promise.all([
    prisma.eye_clinic.count(),
    prisma.optical_shop.count(),
  ]);
  console.log(`\n완료 — 안과 ${a}곳, 안경점 ${b}곳`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
