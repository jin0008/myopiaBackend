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

/** 상세정보 서비스. 진료시간·점심시간·접수마감·층 안내가 여기에만 있다.
 *  요양기호를 이미 알 때 그 기관 하나만 준다 - 목록도 폐업도 모른다. */
const DETAIL = "https://apis.data.go.kr/B551182/MadmDtlInfoService2.8";

/** 상세정보는 하루 10,000 콜이다. 한 번에 다 부르지 않는다 - 신고한 곳이
 *  37% 뿐이라 매주 2,041 콜을 태울 값이 아니다. 새로 나타난 기관만 부른다.
 *  한 번에 이보다 많으면 나눠서 여러 주에 걸쳐 채운다. */
const DETAIL_BUDGET = 300;

if (KEY === "" && require.main === module) {
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

/** "0830" 과 1730 이 섞여 온다 - 종료시각이 정수로 오는 곳이 있다.
 *  네 자리로 맞춰 두지 않으면 앞자리 0 이 사라져 시각이 어긋난다. */
function hhmm(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/\D/g, "");
  if (s === "") return null;
  return s.padStart(4, "0");
}

const DAY_FIELDS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 기존 CSV 와 같은 모양으로 쓴다 - `{"0": ["0830", "1730"], "1": ...}`. */
function stringifyHours(hours: Record<string, [string, string]>): string {
  const parts = Object.entries(hours).map(
    ([day, [from, to]]) => `"${day}": ["${from}", "${to}"]`,
  );
  return `{${parts.join(", ")}}`;
}

/** 한 기관의 상세정보를 CSV 칸으로 바꾼다. 없으면 빈 칸을 돌려준다. */
export async function fetchDetail(ykiho: string): Promise<Partial<Row>> {
  const qs = new URLSearchParams({ ykiho, _type: "json", numOfRows: "10", pageNo: "1" });
  const resp = await fetch(`${DETAIL}/getDtlInfo2.8?serviceKey=${KEY}&${qs}`);
  if (!resp.ok) throw new Error(`상세정보 ${ykiho}: HTTP ${resp.status}`);
  const body = await resp.json();
  const items = body?.response?.body?.items;
  const item = items && typeof items === "object" ? (items as any).item : null;
  if (item == null) return {};
  const d = (Array.isArray(item) ? item[0] : item) as Record<string, unknown>;

  // 월=0. 시작과 끝이 모두 있어야 한 칸으로 친다 - 한쪽만 신고한 곳이 있다.
  const hours: Record<string, [string, string]> = {};
  DAY_FIELDS.forEach((day, i) => {
    const from = hhmm(d[`trmt${day}Start`]);
    const to = hhmm(d[`trmt${day}End`]);
    if (from != null && to != null) hours[String(i)] = [from, to];
  });

  return {
    // 기존 CSV 는 파이썬이 써서 `", "` 로 띄어져 있다. 모양을 맞추지 않으면
    // 첫 갱신에서 757줄이 공백 때문에 바뀐 것으로 보여 진짜 변경을 가린다.
    hours: Object.keys(hours).length > 0 ? stringifyHours(hours) : "",
    lunch: String(d.lunchWeek ?? ""),
    recv: String(d.rcvWeek ?? ""),
    place: String(d.plcNm ?? ""),
  };
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

  // 신규 기관과, 아직 한 번도 상세를 못 받아 본 기관을 채운다.
  const needDetail = clinics.filter((c) => !existing.has(c.ykiho));
  const budgeted = needDetail.slice(0, DETAIL_BUDGET);
  console.log(`안과 ${clinics.length}곳 (신규 ${needDetail.length}곳, 이번에 상세 ${budgeted.length}곳)`);
  if (needDetail.length > DETAIL_BUDGET) {
    console.log(`  남은 ${needDetail.length - DETAIL_BUDGET}곳은 다음 회차에 채운다.`);
  }

  let done = 0;
  for (const c of budgeted) {
    // 한 곳이 실패해도 갱신 전체를 버리지 않는다. 그 칸만 비워 두고 다음
    // 회차에 다시 시도된다(기존 CSV 에 값이 없으므로 또 신규로 잡힌다).
    try {
      Object.assign(c, await fetchDetail(c.ykiho));
    } catch (e) {
      console.error(`  상세 실패 ${c.name}: ${e instanceof Error ? e.message : e}`);
    }
    if (++done % 50 === 0) console.log(`  상세 ${done}/${budgeted.length}`);
  }

  writeCsv(
    path.join(DIR, "eye_clinics.csv"),
    ["ykiho","name","kind","sido","sigungu","address","phone","homepage","lat","lng","doctors","openedOn","eyeDoctors","hours","lunch","recv","place"],
    clinics,
  );
}

// 다른 스크립트가 fetchDetail 만 가져다 쓸 수 있게, 직접 실행일 때만 돈다.
if (require.main === module) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
