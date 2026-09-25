/**
 * 상세정보 변환이 기존 CSV 를 그대로 재현하는지 본다.
 *
 *   DATA_GO_KR_KEY=... npx tsx scripts/check-facility-detail.ts
 *
 * 공백 한 칸만 달라져도 첫 갱신에서 수백 줄이 바뀐 것으로 보여 진짜
 * 개·폐업을 가린다. 값뿐 아니라 모양까지 같아야 한다.
 *
 * 실제 API 를 부르므로 키가 없으면 건너뛴다.
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { parseCsv } from "../src/lib/csv";
import { fetchDetail } from "./fetch-facilities";

async function main() {
  if ((process.env.DATA_GO_KR_KEY ?? "") === "") {
    console.log("DATA_GO_KR_KEY 가 없어 건너뛴다.");
    return;
  }
  const rows = parseCsv(
    fs.readFileSync(path.join(__dirname, "../src/assets/facilities/eye_clinics.csv"), "utf8"),
  );
  // 네 칸이 모두 채워진 기관으로 본다 - 빈 칸은 비교가 되지 않는다.
  const sample = rows.filter((r) => r.hours && r.lunch && r.recv && r.place).slice(0, 3);
  assert.ok(sample.length > 0, "비교할 표본이 없다");

  for (const r of sample) {
    const got = await fetchDetail(r.ykiho);
    assert.strictEqual(got.hours, r.hours, `${r.name}: hours 가 기존 CSV 와 다르다`);
    assert.strictEqual(got.lunch, r.lunch, `${r.name}: lunch`);
    assert.strictEqual(got.recv, r.recv, `${r.name}: recv`);
    assert.strictEqual(got.place, r.place, `${r.name}: place`);
    console.log(`  ok ${r.name}`);
  }
  console.log(`ok — ${sample.length}곳이 모양까지 그대로 재현된다`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
