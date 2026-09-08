import prisma from "../lib/prisma";
import type { sex as SexEnum } from "@prisma/client";

/**
 * 또래 중 어디쯤인지.
 *
 * 부모가 알고 싶은 것은 20.00mm 이라는 숫자가 아니라 그게 또래에 비해
 * 어떤지다. 의사 화면(myopia PercentileSummary)이 쓰던 계산을 서버로
 * 옮겨, 앱과 의사 화면이 같은 답을 보게 한다 - 임상 계산을 두 벌 두면
 * 언젠가 어긋나고, 어긋난 것을 아무도 모른다.
 *
 * growth_data 는 나이·백분위별 안축장 표다(4~18세, 3·5·10·25·50·75·90·95).
 * 표에 없는 나이는 이웃한 두 나이 사이를 직선으로 잇고, 백분위는 z 점수
 * 위에서 이어 읽는다.
 */

/** 표준정규 역함수(Acklam). 백분위 → z. */
function probit(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return s * y;
}

function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export interface PercentileResult {
  /** 대략 몇 퍼센타일인지. 표 바깥이면 null. */
  percentile: number | null;
  /** 표 바깥일 때 어느 쪽인지. */
  edge: "low" | "high" | null;
  /** 화면에 그릴 눈금: 이 나이의 백분위별 안축장. */
  curve: { percentile: number; value: number }[];
}

/** 기준 자료를 못 찾으면 null. 모르는 것을 아는 척하지 않는다. */
export async function axialPercentile(params: {
  ageYears: number;
  sex: SexEnum;
  axial: number;
  /** 한국 사용자가 주 대상이라 Asian 을 기본으로 둔다. */
  ethnicity?: string;
}): Promise<PercentileResult | null> {
  const rows = await prisma.growth_data.findMany({
    where: { sex: params.sex, ethnicity: params.ethnicity ?? "Asian" },
  });
  if (rows.length === 0) return null;

  const byPct = new Map<number, { age: number; value: number }[]>();
  for (const r of rows) {
    if (!byPct.has(r.percentile)) byPct.set(r.percentile, []);
    byPct.get(r.percentile)!.push({ age: r.age, value: r.value });
  }

  // 나이별 곡선을 이 아이의 나이에서 읽는다. 표 밖의 나이는 양 끝으로 묶는다
  // - 3세 아이에게 4세 값을 쓰는 것이, 아무것도 안 보여 주는 것보다 낫다.
  const pairs: { v: number; z: number; p: number }[] = [];
  for (const [p, arr] of byPct.entries()) {
    const sorted = [...arr].sort((a, b) => a.age - b.age);
    const clamped = Math.max(
      sorted[0].age,
      Math.min(params.ageYears, sorted[sorted.length - 1].age),
    );
    let a0 = sorted[0];
    let a1 = sorted[sorted.length - 1];
    for (let i = 0; i < sorted.length - 1; i++) {
      if (clamped >= sorted[i].age && clamped <= sorted[i + 1].age) {
        a0 = sorted[i];
        a1 = sorted[i + 1];
        break;
      }
    }
    const f = a1.age === a0.age ? 0 : (clamped - a0.age) / (a1.age - a0.age);
    pairs.push({ v: a0.value + (a1.value - a0.value) * f, z: probit(p / 100), p });
  }
  pairs.sort((a, b) => a.v - b.v);

  const curve = pairs.map((x) => ({
    percentile: x.p,
    value: Number(x.v.toFixed(2)),
  }));

  const lowest = pairs[0];
  const highest = pairs[pairs.length - 1];
  if (params.axial <= lowest.v) return { percentile: null, edge: "low", curve };
  if (params.axial >= highest.v) return { percentile: null, edge: "high", curve };

  let lo = pairs[0];
  let hi = pairs[pairs.length - 1];
  for (let i = 0; i < pairs.length - 1; i++) {
    if (params.axial >= pairs[i].v && params.axial <= pairs[i + 1].v) {
      lo = pairs[i];
      hi = pairs[i + 1];
      break;
    }
  }
  const f = (params.axial - lo.v) / (hi.v - lo.v);
  const pct = normCdf(lo.z + (hi.z - lo.z) * f) * 100;
  return { percentile: Number(pct.toFixed(1)), edge: null, curve };
}
