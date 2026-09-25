/**
 * 공공 API 에서 명부를 받아 CSV 를 다시 쓴다.
 *
 *   DATA_GO_KR_KEY=... npx tsx scripts/fetch-facilities.ts
 *
 * 넣는 일은 하지 않는다. CSV 만 바꾸고, 그 diff 를 사람이 PR 에서 본다 -
 * 공공자료는 가끔 통째로 이상해지는데 그걸 잡아낼 유일한 지점이 거기다.
 *
 * ── 처음 돌릴 때 ──────────────────────────────────────────────────────
 * 아래 필드 이름은 공공데이터포털 문서 기준이다. 실제 응답과 다르면
 * assertColumns 가 멈춰 세운다 - 조용히 빈 칸으로 채우지 않는다.
 * 반드시 한 번은 사람이 보는 앞에서 돌리고 diff 를 확인해라.
 *
 * ── 상세정보를 매번 부르지 않는 이유 ───────────────────────────────────
 * hours/lunch/recv/place 는 기관마다 한 번씩 더 불러야 하는데(2,041 콜),
 * 심평원에 신고한 곳이 37% 뿐이라 대부분 빈 칸이다. 주마다 전부 다시
 * 부를 값이 아니다. 새로 나타난 기관만 부르고 나머지는 기존 CSV 값을
 * 그대로 옮긴다.
 */
import fs from "fs";
import path from "path";

import { parseCsv } from "../src/lib/csv";

const KEY = process.env.DATA_GO_KR_KEY ?? "";
const DIR = path.join(__dirname, "../src/assets/facilities");

/** 안과 진료과목 코드. 목록을 이걸로 좁혀야 전국 병원 10만 곳을 안 받는다. */
const DGSBJT_EYE = "12";

if (KEY === "") {
  console.error("DATA_GO_KR_KEY 가 없다. 공공데이터포털 인증키를 넣어라.");
  process.exit(1);
}

type Row = Record<string, string>;

/** 응답에 있어야 할 칸이 없으면 멈춘다. 빈 CSV 를 쓰고 끝나는 것보다 낫다. */
function assertColumns(rows: Row[], required: string[], where: string) {
  if (rows.length === 0) throw new Error(`${where}: 한 건도 받지 못했다`);
  const missing = required.filter((c) => !(c in rows[0]));
  if (missing.length > 0) {
    throw new Error(
      `${where}: 응답에 ${missing.join(", ")} 가 없다. ` +
        `받은 칸: ${Object.keys(rows[0]).join(", ")}`,
    );
  }
}

/** 페이지를 끝까지 읽고, totalCount 와 실제 건수가 맞는지 확인한다.
 *  중간에 끊긴 목록을 그대로 쓰면 폐업 판정이 전국을 쓸어버린다. */
async function fetchAllPages(
  url: string,
  params: Record<string, string>,
  pick: (body: any) => { items: Row[]; total: number },
): Promise<Row[]> {
  const rows: Row[] = [];
  let total = -1;
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ ...params, pageNo: String(page), numOfRows: "1000", _type: "json" });
    const resp = await fetch(`${url}?serviceKey=${KEY}&${qs}`);
    if (!resp.ok) throw new Error(`${url} page ${page}: HTTP ${resp.status}`);
    const body = await resp.json();
    const { items, total: t } = pick(body);
    if (total < 0) total = t;
    rows.push(...items);
    if (items.length === 0 || rows.length >= total) break;
  }
  if (rows.length !== total) {
    throw new Error(`받은 건수(${rows.length})가 totalCount(${total})와 다르다 — 목록이 잘렸다`);
  }
  return rows;
}

function pickItems(body: any): { items: Row[]; total: number } {
  const b = body?.response?.body;
  const item = b?.items?.item;
  const items = item == null ? [] : Array.isArray(item) ? item : [item];
  return { items: items as Row[], total: Number(b?.totalCount ?? 0) };
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, header: string[], rows: Row[]) {
  const out = [header.join(",")];
  for (const r of rows) out.push(header.map((h) => csvEscape(r[h])).join(","));
  fs.writeFileSync(file, out.join("\n") + "\n");
  console.log(`${path.basename(file)} — ${rows.length}줄`);
}

/** 심평원 종별코드를 우리 kind 로. 01 상급종합, 11 종합병원, 21 병원, 31 의원 … */
function kindOf(code: string): string {
  if (code === "01") return "university";
  if (code === "11" || code === "21") return "general";
  return "clinic";
}

async function main() {
  const existing = new Map(
    parseCsv(fs.readFileSync(path.join(DIR, "eye_clinics.csv"), "utf8")).map((r) => [r.ykiho, r]),
  );

  const raw = await fetchAllPages(
    "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList",
    { dgsbjtCd: DGSBJT_EYE },
    pickItems,
  );
  assertColumns(raw, ["ykiho", "yadmNm", "clCd", "sidoCdNm", "sgguCdNm", "addr", "XPos", "YPos"], "안과 목록");

  const clinics: Row[] = raw.map((r) => {
    // 신고 항목(진료시간 등)은 상세 API 에만 있다. 기존 값을 잃지 않는다.
    const old = existing.get(r.ykiho) ?? {};
    return {
      ykiho: r.ykiho,
      name: r.yadmNm,
      kind: kindOf(r.clCd),
      sido: r.sidoCdNm,
      sigungu: r.sgguCdNm,
      address: r.addr,
      phone: r.telno ?? "",
      homepage: r.hospUrl ?? old.homepage ?? "",
      lat: r.YPos,
      lng: r.XPos,
      doctors: r.drTotCnt ?? "",
      openedOn: r.estbDd ?? "",
      eyeDoctors: r.mdeptSdrCnt ?? old.eyeDoctors ?? "",
      hours: old.hours ?? "",
      lunch: old.lunch ?? "",
      recv: old.recv ?? "",
      place: old.place ?? "",
    };
  });

  const fresh = clinics.filter((c) => !existing.has(c.ykiho)).length;
  console.log(`안과 ${clinics.length}곳 (신규 ${fresh}곳, 상세정보는 신규만 따로 받아라)`);

  writeCsv(
    path.join(DIR, "eye_clinics.csv"),
    ["ykiho","name","kind","sido","sigungu","address","phone","homepage","lat","lng","doctors","openedOn","eyeDoctors","hours","lunch","recv","place"],
    clinics,
  );
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
