/**
 * 목록 선별 규칙이 기존 명부를 그대로 재현하는지 본다.
 *
 *   DATA_GO_KR_KEY=... npx tsx scripts/check-facility-list.ts
 *
 * 진료과목 안과로 받으면 4,395 곳이 온다. 우리 명부는 2,041 곳이다.
 * 차이를 가르는 규칙이 틀어지면 찾기탭이 동네 의원으로 덮이거나
 * 대학병원 안과가 사라진다 - 둘 다 조용히 일어난다.
 *
 * 실제 API 를 부르므로 키가 없으면 건너뛴다.
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { parseCsv } from "../src/lib/csv";
import { isEyeDirectoryMember, fetchEyeDoctors } from "./fetch-facilities";

const KEY = process.env.DATA_GO_KR_KEY ?? "";
const LIST = "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList";

async function fetchList(): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page < 20; page++) {
    const qs = new URLSearchParams({ _type: "json", numOfRows: "1000", pageNo: String(page), dgsbjtCd: "12" });
    const body: any = await (await fetch(`${LIST}?serviceKey=${KEY}&${qs}`)).json();
    const b = body?.response?.body;
    const item = b?.items?.item;
    const items = item == null ? [] : Array.isArray(item) ? item : [item];
    if (items.length === 0) break;
    rows.push(...items);
    if (rows.length >= Number(b.totalCount)) break;
  }
  return rows;
}

async function main() {
  if (KEY === "") {
    console.log("DATA_GO_KR_KEY 가 없어 건너뛴다.");
    return;
  }
  const csvRows = parseCsv(
    fs.readFileSync(path.join(__dirname, "../src/assets/facilities/eye_clinics.csv"), "utf8"),
  );
  const ours = new Map(csvRows.map((r) => [r.ykiho, r]));

  const all = await fetchList();
  const selected = new Set(
    all.filter((r) => isEyeDirectoryMember(r.clCd, r.yadmNm)).map((r) => String(r.ykiho)),
  );

  const dropped = [...ours.keys()].filter((k) => !selected.has(k));
  console.log(`API ${all.length}곳 → 규칙 적용 ${selected.size}곳 (기존 명부 ${ours.size}곳)`);
  console.log(`  기존 중 빠지는 곳 ${dropped.length}, 새로 들어오는 곳 ${selected.size - (ours.size - dropped.length)}`);

  // 기존 명부가 한 곳도 빠지면 안 된다. 새로 들어오는 곳은 개원이라 정상이다.
  assert.deepStrictEqual(
    dropped.map((k) => ours.get(k)!.name),
    [],
    "규칙이 기존 명부를 빠뜨린다",
  );

  // 안과 전문의 수도 기존 값과 맞는지 한 곳만 확인한다.
  const sample = csvRows.find((r) => Number(r.eyeDoctors) > 0)!;
  assert.strictEqual(
    await fetchEyeDoctors(sample.ykiho),
    sample.eyeDoctors,
    `${sample.name}: 안과 전문의 수가 기존 CSV 와 다르다`,
  );

  console.log("ok — 기존 명부를 하나도 빠뜨리지 않고, 전문의 수도 재현된다");
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
