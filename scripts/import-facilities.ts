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

const DIR = path.join(__dirname, "../src/assets/facilities");

/** 따옴표로 감싼 칸과 그 안의 쉼표를 다룬다. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((c) => c !== ""));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
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
      phone: c.phone || null,
      homepage: c.homepage || null,
      lat: Number(c.lat),
      lng: Number(c.lng),
      doctors: int(c.doctors),
      opened_on: c.openedOn || null,
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
      phone: s.phone || null,
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
