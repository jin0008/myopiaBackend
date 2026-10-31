/**
 * 안축장 참조 곡선(normative/reference) 만들 수 있는지 숫자로 본다.
 *
 *   npx tsx scripts/al-feasibility.ts                  # 화면에 출력
 *   npx tsx scripts/al-feasibility.ts > al.txt         # 파일로 저장
 *   npx tsx scripts/al-feasibility.ts --names > al.txt # 병원 이름까지(문의용)
 *
 * 읽기만 한다. 생년월일은 서버와 같은 KMS 키로 메모리에서만 복호화하고,
 * 출력에는 환자 식별 정보 없이 집계값만 나온다. 병원은 기본적으로 크기 순
 * 기호(H01, H02 …)로만 나오고, --names 를 주면 이름이 함께 나온다.
 * 20명 미만 칸의 중앙값은 내지 않는다.
 */
import "dotenv/config";

/* ------------------------------------------------------------------ *
 * 기준값                                                              *
 * ------------------------------------------------------------------ */
const AL_MIN = 18; // mm, 이 밖은 입력 오류로 본다
const AL_MAX = 32;
const ODOS_MAX_DIFF = 1.5; // mm, 양안 차가 이보다 크면 의심
const AGE_MIN = 2;
const AGE_MAX = 25;
const VEL_MIN = -0.2; // mm/년, 이보다 줄거나
const VEL_MAX = 1.5; //  이보다 빨리 늘면 의심
const MIN_GAP_Y = 0.5; // 속도 계산에 쓰는 최소 간격
const MEDIAN_MIN_N = 20;
const DECRYPT_CONCURRENCY = 16;
const BATCH = 500;
const REFR_WINDOW_DAYS = 90; // 안축장 측정일과 굴절 검사일이 이만큼 안이면 짝으로 본다
const MYOPIA_SE = -0.5; // D, 이하이면 근시
const MAIN_INSTRUMENTS = ["IOL-Master 700", "IOL-Master 500", "AL-scan"];
const CYCLO = "Cycloplegic refraction";

/* ------------------------------------------------------------------ *
 * 집계에 쓰는 형태 (DB 와 무관)                                          *
 * ------------------------------------------------------------------ */
export type Sex = "male" | "female";
export interface Meas {
  date: Date;
  od: number | null;
  os: number | null;
  instrument: string;
}
export interface Tx {
  name: string;
  start: Date;
  end: Date | null;
}
export interface Refr {
  date: Date;
  se: number | null; // 우안 등가구면, 없으면 좌안
  method: string;
}
export interface Pt {
  sex: Sex;
  ethnicity: string;
  hospital: string; // 내부 집계용 id. 출력하지 않는다.
  hospitalName: string; // --names 일 때만 출력
  country: string;
  refr: Refr[];
  dob: Date | null; // 복호화 실패면 null
  meas: Meas[];
  tx: Tx[];
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const years = (a: Date, b: Date) => (b.getTime() - a.getTime()) / YEAR_MS;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const inc = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const pct = (a: number, b: number) => (b === 0 ? "-" : ((100 * a) / b).toFixed(1) + "%");
const pad = (s: string | number, w: number) => String(s).padStart(w);
const fmt = (x: number | null, d = 2) => (x == null ? "-" : x.toFixed(d));

function validAL(v: number | null): v is number {
  return v != null && v >= AL_MIN && v <= AL_MAX;
}
/** 대표값: 우안. 우안이 없거나 범위 밖이면 좌안. */
function eyeValue(m: Meas): number | null {
  if (validAL(m.od)) return m.od;
  if (validAL(m.os)) return m.os;
  return null;
}

/* ------------------------------------------------------------------ *
 * 집계                                                                *
 * ------------------------------------------------------------------ */
export function summarize(ptsIn: Pt[], opts: { names?: boolean } = {}): string {
  // 치료 이름이 "None" 인 기록은 치료가 없는 것으로 본다.
  const pts = ptsIn.map((x) => ({ ...x, tx: x.tx.filter((t) => t.name !== "None") }));
  const out: string[] = [];
  const p = (s = "") => out.push(s);

  const withAL = pts.filter((x) => x.meas.some((m) => m.od != null || m.os != null));
  const dobFail = withAL.filter((x) => x.dob == null).length;

  // 품질 플래그
  let nMeas = 0,
    outOfRange = 0,
    odosDiff = 0,
    badAge = 0;
  const instr = new Map<string, number>();
  for (const x of withAL) {
    for (const m of x.meas) {
      if (m.od == null && m.os == null) continue;
      nMeas++;
      inc(instr, m.instrument);
      for (const v of [m.od, m.os]) if (v != null && !validAL(v)) outOfRange++;
      if (m.od != null && m.os != null && Math.abs(m.od - m.os) > ODOS_MAX_DIFF) odosDiff++;
      if (x.dob) {
        const a = years(x.dob, m.date);
        if (a < AGE_MIN || a > AGE_MAX) badAge++;
      }
    }
  }

  /* 1. 규모 */
  p("=== 1. 규모 ===");
  p(`전체 환자                         ${pad(pts.length, 7)}`);
  p(`안축장 측정 1회 이상               ${pad(withAL.length, 7)}`);
  const visits = (x: Pt) => new Set(x.meas.filter((m) => m.od != null || m.os != null).map((m) => m.date.toISOString().slice(0, 10))).size;
  for (const k of [2, 3, 5]) {
    p(`안축장 측정일 ${k}회 이상            ${pad(withAL.filter((x) => visits(x) >= k).length, 7)}`);
  }
  p(`측정 건수(측정일×행)               ${pad(nMeas, 7)}`);
  p(`병원 수                            ${pad(new Set(withAL.map((x) => x.hospital)).size, 7)}`);
  const byHosp = new Map<string, number>();
  withAL.forEach((x) => inc(byHosp, x.hospital));
  const hs = [...byHosp.values()].sort((a, b) => b - a);
  p(`가장 큰 병원 1곳의 환자 비중        ${pad(pct(hs[0] ?? 0, withAL.length), 7)}`);
  p(`상위 3곳의 환자 비중               ${pad(pct(hs.slice(0, 3).reduce((a, b) => a + b, 0), withAL.length), 7)}`);
  p();

  /* 2. 품질 */
  p("=== 2. 데이터 품질 ===");
  p(`생년월일 복호화 실패               ${pad(dobFail, 7)}  (${pct(dobFail, withAL.length)})`);
  p(`측정 시 나이가 ${AGE_MIN}~${AGE_MAX}세 밖         ${pad(badAge, 7)}  (${pct(badAge, nMeas)})`);
  p(`안축장 ${AL_MIN}~${AL_MAX}mm 밖 (안 단위)      ${pad(outOfRange, 7)}`);
  p(`양안 차 > ${ODOS_MAX_DIFF}mm                  ${pad(odosDiff, 7)}  (${pct(odosDiff, nMeas)})`);
  p();

  /* 3. 기기·민족·성별·치료 */
  p("=== 3. 분포 ===");
  p("[기기] (측정 건수)");
  [...instr.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => p(`  ${k.padEnd(20)} ${pad(v, 7)}  ${pad(pct(v, nMeas), 6)}`));
  const eth = new Map<string, number>();
  withAL.forEach((x) => inc(eth, x.ethnicity));
  p("[민족] (환자 수)");
  [...eth.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => p(`  ${k.padEnd(20)} ${pad(v, 7)}  ${pad(pct(v, withAL.length), 6)}`));
  const sx = new Map<string, number>();
  withAL.forEach((x) => inc(sx, x.sex));
  p(`[성별] 남 ${sx.get("male") ?? 0} / 여 ${sx.get("female") ?? 0}`);
  const txn = new Map<string, number>();
  let noTx = 0;
  withAL.forEach((x) => {
    if (x.tx.length === 0) noTx++;
    new Set(x.tx.map((t) => t.name)).forEach((n) => inc(txn, n));
  });
  p("[치료 기록] (환자 수, 중복 가능)");
  p(`  ${"(치료 기록 없음)".padEnd(20)} ${pad(noTx, 7)}  ${pad(pct(noTx, withAL.length), 6)}`);
  [...txn.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => p(`  ${k.padEnd(20)} ${pad(v, 7)}  ${pad(pct(v, withAL.length), 6)}`));
  p();

  /* 측정값 정리: 나이 붙이고, 치료 전 여부 표시 */
  type Row = { age: number; al: number; date: Date; untreated: boolean; instrument: string };
  const rows = new Map<Pt, Row[]>();
  for (const x of withAL) {
    if (!x.dob) continue;
    const firstTx = x.tx.length ? new Date(Math.min(...x.tx.map((t) => t.start.getTime()))) : null;
    const byDate = new Map<string, Row>();
    for (const m of x.meas) {
      const al = eyeValue(m);
      if (!validAL(al)) continue;
      const age = years(x.dob, m.date);
      if (age < AGE_MIN || age > AGE_MAX) continue;
      // 치료 시작일 당일 측정은 치료 전(기저)으로 본다.
      const untreated = firstTx == null || m.date.getTime() <= firstTx.getTime();
      byDate.set(m.date.toISOString().slice(0, 10), { age, al, date: m.date, untreated, instrument: m.instrument });
    }
    rows.set(x, [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime()));
  }

  /* 4. 횡단면: 연령×성별 */
  p("=== 4. 횡단면 (연령 1세 구간 × 성별, 환자 수) ===");
  p("  '전체' = 그 나이에 측정이 있는 환자, '치료전' = 치료 시작 전 측정만");
  p("  중앙값 = 치료전, 우안(없으면 좌안), 환자당 그 구간 첫 측정 1회. n<20 이면 '-'");
  p(`  ${"나이".padEnd(4)} | ${pad("남 전체", 7)} ${pad("남 치료전", 8)} ${pad("남 중앙값", 8)} | ${pad("여 전체", 7)} ${pad("여 치료전", 8)} ${pad("여 중앙값", 8)}`);
  for (let a = AGE_MIN; a < 19; a++) {
    const cells: string[] = [];
    for (const s of ["male", "female"] as Sex[]) {
      let all = 0;
      const untreatedVals: number[] = [];
      for (const [x, rs] of rows) {
        if (x.sex !== s) continue;
        const inBand = rs.filter((r) => Math.floor(r.age) === a);
        if (inBand.length === 0) continue;
        all++;
        const u = inBand.find((r) => r.untreated);
        if (u) untreatedVals.push(u.al);
      }
      const med = untreatedVals.length >= MEDIAN_MIN_N ? median(untreatedVals) : null;
      cells.push(`${pad(all, 7)} ${pad(untreatedVals.length, 8)} ${pad(fmt(med), 8)}`);
    }
    p(`  ${pad(a, 4)} | ${cells[0]} | ${cells[1]}`);
  }
  p();

  /* 5. 종단: 치료 전 구간의 연간 증가량 */
  p("=== 5. 종단 (치료 전 구간만) ===");
  let pt2 = 0,
    pt05 = 0,
    pt1 = 0,
    pt2y = 0;
  const vel: { age: number; v: number; sex: Sex; sameInstr: boolean }[] = [];
  let velOut = 0;
  const spans: number[] = [];
  for (const [x, rs] of rows) {
    const u = rs.filter((r) => r.untreated);
    if (u.length < 2) continue;
    pt2++;
    const span = years(u[0].date, u[u.length - 1].date);
    spans.push(span);
    if (span >= 0.5) pt05++;
    if (span >= 1) pt1++;
    if (span >= 2) pt2y++;
    // 연속 측정 간 속도. 간격이 짧으면 다음 측정과 묶는다.
    let i = 0;
    for (let j = 1; j < u.length; j++) {
      const g = years(u[i].date, u[j].date);
      if (g < MIN_GAP_Y) continue;
      const v = (u[j].al - u[i].al) / g;
      if (v < VEL_MIN || v > VEL_MAX) velOut++;
      else vel.push({ age: (u[i].age + u[j].age) / 2, v, sex: x.sex, sameInstr: u[i].instrument === u[j].instrument });
      i = j;
    }
  }
  p(`치료 전 측정 2회 이상 환자           ${pad(pt2, 7)}`);
  p(`  그중 추적 0.5년 이상               ${pad(pt05, 7)}`);
  p(`  그중 추적 1년 이상                 ${pad(pt1, 7)}`);
  p(`  그중 추적 2년 이상                 ${pad(pt2y, 7)}`);
  p(`추적 기간 중앙값(년)                 ${pad(fmt(median(spans)), 7)}`);
  p(`연간 증가량 구간 수 (간격≥${MIN_GAP_Y}년)     ${pad(vel.length, 7)}`);
  p(`  같은 기기로 잰 구간               ${pad(vel.filter((r) => r.sameInstr).length, 7)}`);
  p(`  이상치로 뺀 구간 (<${VEL_MIN} 또는 >${VEL_MAX})  ${pad(velOut, 7)}`);
  p();
  p("  연간 증가량(mm/년) — 구간 중간 나이 기준");
  p(`  ${"나이".padEnd(6)} | ${pad("남 n", 5)} ${pad("P25", 6)} ${pad("P50", 6)} ${pad("P75", 6)} | ${pad("여 n", 5)} ${pad("P25", 6)} ${pad("P50", 6)} ${pad("P75", 6)}`);
  for (const [lo, hi] of [[4, 6], [6, 8], [8, 10], [10, 12], [12, 14], [14, 16], [16, 19]]) {
    const cells: string[] = [];
    for (const s of ["male", "female"] as Sex[]) {
      const vs = vel.filter((r) => r.sex === s && r.age >= lo && r.age < hi).map((r) => r.v);
      const ok = vs.length >= MEDIAN_MIN_N;
      cells.push(`${pad(vs.length, 5)} ${pad(ok ? fmt(quantile(vs, 0.25)) : "-", 6)} ${pad(ok ? fmt(quantile(vs, 0.5)) : "-", 6)} ${pad(ok ? fmt(quantile(vs, 0.75)) : "-", 6)}`);
    }
    p(`  ${(lo + "-" + (hi - 1)).padEnd(6)} | ${cells[0]} | ${cells[1]}`);
  }
  p();
  /* 6. 병원별 */
  p("=== 6. 병원별 점검 (환자 수 순) ===");
  p("  치료% = 치료 기록 있는 환자 비율, 굴절% = 굴절값 1회 이상 있는 환자 비율");
  p("  AL8-10 = 8~10세 치료전 첫 측정 안축장 중앙값(남녀 합산, n<20 이면 '-')");
  type H = { name: string; country: string; pts: Pt[] };
  const hmap = new Map<string, H>();
  for (const x of withAL) {
    const h = hmap.get(x.hospital) ?? { name: x.hospitalName, country: x.country, pts: [] };
    h.pts.push(x);
    hmap.set(x.hospital, h);
  }
  const hlist = [...hmap.values()].sort((a, b) => b.pts.length - a.pts.length);
  p(`  ${"병원".padEnd(5)} ${"국가".padEnd(12)} ${pad("환자", 6)} ${pad("치료%", 7)} ${pad("EastA%", 7)} ${pad("SouthA%", 8)} ${pad("굴절%", 7)} ${pad("치료전2+", 8)} ${pad("AL8-10", 7)}  주 기기`);
  hlist.forEach((h, i) => {
    const n = h.pts.length;
    const txp = h.pts.filter((x) => x.tx.length > 0).length;
    const ea = h.pts.filter((x) => x.ethnicity === "East Asian").length;
    const sa = h.pts.filter((x) => x.ethnicity === "South Asian").length;
    const rf = h.pts.filter((x) => x.refr.some((r) => r.se != null)).length;
    let u2 = 0;
    const al: number[] = [];
    const ins = new Map<string, number>();
    for (const x of h.pts) {
      x.meas.forEach((m) => inc(ins, m.instrument));
      const rs = rows.get(x) ?? [];
      if (rs.filter((r) => r.untreated).length >= 2) u2++;
      const f = rs.find((r) => r.untreated && r.age >= 8 && r.age < 11);
      if (f) al.push(f.al);
    }
    const topIns = [...ins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
    const label = "H" + String(i + 1).padStart(2, "0");
    p(
      `  ${label.padEnd(5)} ${h.country.slice(0, 12).padEnd(12)} ${pad(n, 6)} ${pad(pct(txp, n), 7)} ${pad(pct(ea, n), 7)} ${pad(pct(sa, n), 8)} ${pad(pct(rf, n), 7)} ${pad(u2, 8)} ${pad(al.length >= MEDIAN_MIN_N ? fmt(median(al)) : "-", 7)}  ${topIns}` +
        (opts.names ? `  [${h.name}]` : ""),
    );
  });
  p();

  /* 7. 굴절값 */
  p("=== 7. 굴절값 현황 ===");
  const methods = new Map<string, number>();
  let nRefr = 0;
  for (const x of withAL) for (const r of x.refr) if (r.se != null) { nRefr++; inc(methods, r.method); }
  const withRefr = withAL.filter((x) => x.refr.some((r) => r.se != null)).length;
  p(`굴절값 1회 이상 환자                ${pad(withRefr, 7)}  (${pct(withRefr, withAL.length)})`);
  p(`굴절 검사 건수                     ${pad(nRefr, 7)}`);
  [...methods.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => p(`  ${k.padEnd(24)} ${pad(v, 7)}  ${pad(pct(v, nRefr), 6)}`));

  /** 안축장 측정일 앞뒤 REFR_WINDOW_DAYS 안의 굴절값. 조절마비 굴절을 먼저, 그다음 가까운 날. */
  const nearRefr = (x: Pt, d: Date): Refr | null => {
    const win = REFR_WINDOW_DAYS * 864e5;
    const c = x.refr.filter((r) => r.se != null && Math.abs(r.date.getTime() - d.getTime()) <= win);
    if (c.length === 0) return null;
    c.sort((a, b) => (a.method === CYCLO ? 0 : 1) - (b.method === CYCLO ? 0 : 1) || Math.abs(a.date.getTime() - d.getTime()) - Math.abs(b.date.getTime() - d.getTime()));
    return c[0];
  };
  let paired = 0,
    pairedCyclo = 0;
  for (const [x, rs] of rows) for (const r of rs) {
    const q = nearRefr(x, r.date);
    if (q) { paired++; if (q.method === CYCLO) pairedCyclo++; }
  }
  const totalRows = [...rows.values()].reduce((a, rs) => a + rs.length, 0);
  p(`안축장 측정 중 ±${REFR_WINDOW_DAYS}일 안에 굴절값 있음   ${pad(paired, 7)}  (${pct(paired, totalRows)})`);
  p(`  그중 조절마비 굴절                ${pad(pairedCyclo, 7)}  (${pct(pairedCyclo, paired)})`);
  p();
  p(`  연령별 근시(SE ≤ ${MYOPIA_SE}D) 비율 — 치료전 첫 측정에 짝지어진 굴절값 기준`);
  p(`  ${"나이".padEnd(6)} | ${pad("n", 5)} ${pad("근시%", 7)} ${pad("SE중앙값", 8)} ${pad("고도근시%", 9)}`);
  for (const [lo, hi] of [[3, 6], [6, 8], [8, 10], [10, 12], [12, 14], [14, 19]]) {
    const ses: number[] = [];
    for (const [x, rs] of rows) {
      const f = rs.find((r) => r.untreated && r.age >= lo && r.age < hi);
      if (!f) continue;
      const q = nearRefr(x, f.date);
      if (q?.se != null) ses.push(q.se);
    }
    const my = ses.filter((v) => v <= MYOPIA_SE).length;
    const hm = ses.filter((v) => v <= -6).length;
    p(`  ${(lo + "-" + (hi - 1)).padEnd(6)} | ${pad(ses.length, 5)} ${pad(pct(my, ses.length), 7)} ${pad(ses.length >= MEDIAN_MIN_N ? fmt(median(ses)) : "-", 8)} ${pad(pct(hm, ses.length), 9)}`);
  }
  p();

  /* 8. 근시 상태별 연간 증가량 (분석 후보 집단) */
  p("=== 8. 근시 상태별 연간 증가량 (치료전, East Asian, 주 기기 3종, 같은 기기 구간) ===");
  p(`  주 기기 = ${MAIN_INSTRUMENTS.join(", ")}`);
  p(`  근시 상태 = 구간 시작 측정 ±${REFR_WINDOW_DAYS}일 굴절값(조절마비 우선)의 SE`);
  type V = { age: number; v: number; myopic: boolean | null };
  const vs8: V[] = [];
  for (const [x, rs] of rows) {
    if (x.ethnicity !== "East Asian") continue;
    const u = rs.filter((r) => r.untreated && MAIN_INSTRUMENTS.includes(r.instrument));
    let i = 0;
    for (let j = 1; j < u.length; j++) {
      const g = years(u[i].date, u[j].date);
      if (g < MIN_GAP_Y) continue;
      if (u[i].instrument === u[j].instrument) {
        const v = (u[j].al - u[i].al) / g;
        if (v >= VEL_MIN && v <= VEL_MAX) {
          const q = nearRefr(x, u[i].date);
          vs8.push({ age: (u[i].age + u[j].age) / 2, v, myopic: q?.se == null ? null : q.se <= MYOPIA_SE });
        }
      }
      i = j;
    }
  }
  const cls = vs8.filter((r) => r.myopic != null).length;
  p(`  구간 수 ${vs8.length} (근시 상태 분류됨 ${cls}, ${pct(cls, vs8.length)})`);
  p(`  ${"나이".padEnd(6)} | ${pad("근시 n", 6)} ${pad("P25", 6)} ${pad("P50", 6)} ${pad("P75", 6)} | ${pad("비근시 n", 7)} ${pad("P25", 6)} ${pad("P50", 6)} ${pad("P75", 6)} | ${pad("미분류 n", 7)} ${pad("P50", 6)}`);
  for (const [lo, hi] of [[4, 6], [6, 8], [8, 10], [10, 12], [12, 14], [14, 19]]) {
    const band = vs8.filter((r) => r.age >= lo && r.age < hi);
    const q3 = (xs: number[]) => {
      const ok = xs.length >= MEDIAN_MIN_N;
      return `${pad(ok ? fmt(quantile(xs, 0.25)) : "-", 6)} ${pad(ok ? fmt(quantile(xs, 0.5)) : "-", 6)} ${pad(ok ? fmt(quantile(xs, 0.75)) : "-", 6)}`;
    };
    const my = band.filter((r) => r.myopic === true).map((r) => r.v);
    const nm = band.filter((r) => r.myopic === false).map((r) => r.v);
    const un = band.filter((r) => r.myopic == null).map((r) => r.v);
    p(`  ${(lo + "-" + (hi - 1)).padEnd(6)} | ${pad(my.length, 6)} ${q3(my)} | ${pad(nm.length, 7)} ${q3(nm)} | ${pad(un.length, 7)} ${pad(un.length >= MEDIAN_MIN_N ? fmt(median(un)) : "-", 6)}`);
  }
  p();
  p("참고: 표본이 안정적인 참조 곡선을 만들려면 연령·성별 칸마다 대략");
  p("      중앙부(P10~P90) 100명 이상, 양 끝(P2/P98) 300~500명 이상이 필요하다.");
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * DB 읽기 (서버에서만)                                                  *
 * ------------------------------------------------------------------ */
async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let k = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (k < items.length) {
        const i = k++;
        res[i] = await f(items[i]);
      }
    }),
  );
  return res;
}

/** 등가구면 = 구면 + 원주/2. 구면이 없으면 null. 원주가 없으면 0 으로 본다. */
function seOf(sph: number | null, cyl: number | null): number | null {
  if (sph == null) return null;
  const se = sph + (cyl ?? 0) / 2;
  return se < -30 || se > 20 ? null : se; // 입력 오류
}

function parseDob(s: string): Date | null {
  const d = s.slice(0, 10); // "2015-03-12" 또는 "2015-03-12T00:00:00.000Z"
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(d + "T00:00:00Z");
  return isNaN(t.getTime()) ? null : t;
}

async function main() {
  const prisma = (await import("../src/lib/prisma")).default;
  const { decryptSymmetric } = await import("../src/services/encrpytion");

  const pts: Pt[] = [];
  let cursor: string | undefined;
  let decryptErrors = 0;
  for (;;) {
    const batch = await prisma.patient.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        sex: true,
        hospital_id: true,
        hospital: { select: { name: true, name_ko: true, country: { select: { name: true } } } },
        encrypted_date_of_birth: true,
        ethnicity: { select: { name: true } },
        measurement: { select: { date: true, od: true, os: true, instrument: { select: { name: true } } } },
        patient_treatment: { select: { start_date: true, end_date: true, treatment: { select: { name: true } } } },
        refractive_error: {
          select: {
            date: true,
            od_sph: true,
            od_cyl: true,
            os_sph: true,
            os_cyl: true,
            refractive_error_method: { select: { name: true } },
          },
        },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    const dobs = await pool(batch, DECRYPT_CONCURRENCY, async (b) => {
      if (b.measurement.length === 0) return null; // 측정 없는 환자는 복호화하지 않는다
      try {
        return parseDob(await decryptSymmetric(b.encrypted_date_of_birth));
      } catch {
        decryptErrors++;
        return null;
      }
    });
    batch.forEach((b, i) =>
      pts.push({
        sex: b.sex as Sex,
        ethnicity: b.ethnicity.name,
        hospital: b.hospital_id,
        hospitalName: b.hospital.name_ko ?? b.hospital.name,
        country: b.hospital.country.name,
        dob: dobs[i],
        refr: b.refractive_error.map((r) => ({
          date: r.date,
          se: seOf(r.od_sph, r.od_cyl) ?? seOf(r.os_sph, r.os_cyl),
          method: r.refractive_error_method.name,
        })),
        meas: b.measurement.map((m) => ({ date: m.date, od: m.od, os: m.os, instrument: m.instrument.name })),
        tx: b.patient_treatment.map((t) => ({ name: t.treatment.name, start: t.start_date, end: t.end_date })),
      }),
    );
    process.stderr.write(`\r읽은 환자 ${pts.length}`);
  }
  process.stderr.write("\n");

  console.log(`안축장 참조 곡선 가능성 점검 — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`(KMS 복호화 오류 ${decryptErrors}건)\n`);
  console.log(summarize(pts, { names: process.argv.includes("--names") }));
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
