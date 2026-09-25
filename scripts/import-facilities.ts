/**
 * 전국 안과·안경점 명부를 CSV 에서 읽어 넣는다.
 *
 *   npx tsx scripts/import-facilities.ts
 *
 * 같은 기관은 요양기호(안과)·인허가 관리번호(안경점)로 알아보고 덮어쓴다.
 * 자료가 갱신되면 CSV 만 바꾸고 다시 돌리면 된다.
 *
 * 이번 파일에 없는 곳은 closed_at 을 찍는다. 지우지는 않는다 - 광고와
 * 파트너 계정이 요양기호·인허가번호를 문자열로 들고 있어, 행을 지우면
 * 막아 주는 것 없이 참조만 끊긴다.
 *
 * 잘린 파일이 전국을 폐업시키는 것을 막으려고 lib/facilityClosure.ts 의
 * 한계를 먼저 통과해야 한다. 막히면 폐업 판정만 건너뛰고 upsert 는 그대로
 * 진행한다 - 새로 생긴 곳은 반영하되 지우는 쪽만 보류하는 안전한 실패다.
 */
import fs from "fs";
import path from "path";

import prisma from "../src/lib/prisma";
import { parseCsv } from "../src/lib/csv";
import { areaCodeFor, normalizePhone } from "../src/lib/phone";
import { decideClosures } from "../src/lib/facilityClosure";

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

/** 폐업/재개업을 반영한다. 한계에 걸리면 아무것도 바꾸지 않고 알린다. */
async function applyClosures(
  label: string,
  incoming: string[],
  readKnown: () => Promise<{ key: string; closed: boolean }[]>,
  write: (keys: string[], closedAt: Date | null) => Promise<unknown>,
) {
  const known = await readKnown();
  const verdict = decideClosures(
    known.filter((k) => !k.closed).map((k) => k.key),
    known.filter((k) => k.closed).map((k) => k.key),
    incoming,
  );

  if (!verdict.ok) {
    // 실패로 끝내지 않는다. upsert 는 이미 끝났고 그건 안전하다.
    // 사람이 봐야 하는 것은 "왜 이렇게 많이 사라졌는가"다.
    console.error(
      `\n[경고] ${label}: 폐업 판정을 건너뛴다 — ${verdict.reason} ` +
        `(${verdict.disappeared}/${verdict.known}곳)\n` +
        `        자료를 확인한 뒤 다시 돌려라. 새로 생긴 곳은 이미 들어갔다.`,
    );
    process.exitCode = 1;
    return;
  }

  if (verdict.toClose.length > 0) await write(verdict.toClose, new Date());
  if (verdict.toReopen.length > 0) await write(verdict.toReopen, null);
  console.log(`  ${label}: 폐업 ${verdict.toClose.length}곳, 재개업 ${verdict.toReopen.length}곳`);
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

  await applyClosures(
    "안과",
    clinics.map((c) => c.ykiho),
    () => prisma.eye_clinic.findMany({ select: { ykiho: true, closed_at: true } }).then((rows) => rows.map((r) => ({ key: r.ykiho, closed: r.closed_at != null }))),
    (keys, closedAt) => prisma.eye_clinic.updateMany({ where: { ykiho: { in: keys } }, data: { closed_at: closedAt } }),
  );

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

  await applyClosures(
    "안경점",
    shops.map((s) => s.licenseNo),
    () => prisma.optical_shop.findMany({ select: { license_no: true, closed_at: true } }).then((rows) => rows.map((r) => ({ key: r.license_no, closed: r.closed_at != null }))),
    (keys, closedAt) => prisma.optical_shop.updateMany({ where: { license_no: { in: keys } }, data: { closed_at: closedAt } }),
  );

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
