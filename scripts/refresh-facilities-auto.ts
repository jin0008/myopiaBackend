/**
 * 안과·안경원 명부를 받아 검사하고, 괜찮으면 바로 DB 에 넣는다. 주 1회.
 *
 *   npx tsx scripts/refresh-facilities-auto.ts
 *
 * 서버의 systemd timer 가 돌린다(deploy/facilities-refresh.*). 예전에는 GitHub
 * Actions 가 받아 이슈로 알리고 사람이 머지·배포·반영했는데, 매주 그 손을 거칠
 * 만큼 위험한 일이 아니다 - 막아야 할 경우는 정해져 있고 기계가 잴 수 있다.
 *
 *   - 목록이 잘렸다      → fetch 가 totalCount 와 맞지 않으면 던진다
 *   - 칸 이름이 바뀌었다  → fetch 의 assertColumns 가 던진다
 *   - 너무 많이 사라졌다  → 여기서 2% 를 넘으면 멈춘다 (import 에도 같은 선이 있다)
 *   - 너무 많이 생겼다    → 여기서 10% 를 넘으면 멈춘다 (공공자료가 통째로 이상한 날)
 *
 * 멈추거나 실패하면 지난 회차 CSV 로 되돌리고 운영자에게 메일을 보낸다. 다음
 * 회차는 성한 명부와 비교한다. 통과하면 요약을 보낸다.
 *
 * CSV 는 저장소 밖(FACILITIES_DIR, 기본 data/facilities)에 둔다. 저장소 파일을
 * 고치면 다음 git pull 이 충돌한다. 처음 돌 때는 저장소의 명부를 옮겨 와 시작한다.
 */
import "dotenv/config";

import fs from "fs";
import path from "path";

import { parseCsv } from "../src/lib/csv";

const DIR = process.env.FACILITIES_DIR || path.join(__dirname, "../data/facilities");
// fetch·import 스크립트는 불러오는 순간 이 값을 읽는다. 아래에서 동적으로 불러온다.
process.env.FACILITIES_DIR = DIR;
const SEED = path.join(__dirname, "../src/assets/facilities");
const PREV = path.join(DIR, "prev");

/** 한 회차에 이보다 많이 사라지면 멈춘다. import 의 폐업 한계와 같은 선. */
const MAX_REMOVED = 0.02;
/** 한 회차에 이보다 많이 생기면 멈춘다. 첫 회차(좌표 없던 안경원 800여 곳, 8%)는 지난다. */
const MAX_ADDED = 0.1;

const FILES = [
  { file: "eye_clinics.csv", key: "ykiho", label: "안과" },
  { file: "optical_shops.csv", key: "licenseNo", label: "안경원" },
] as const;

type Diff = { label: string; before: number; after: number; added: string[]; removed: string[]; changed: number };

function readKeyed(file: string, key: string): Map<string, Record<string, string>> {
  return new Map(parseCsv(fs.readFileSync(file, "utf8")).map((r) => [r[key], r]));
}

function diffOf(f: (typeof FILES)[number]): Diff {
  const before = readKeyed(path.join(PREV, f.file), f.key);
  const after = readKeyed(path.join(DIR, f.file), f.key);
  const name = (r: Record<string, string> | undefined) => `${r?.name ?? ""} (${r?.address ?? ""})`;
  const added = [...after.keys()].filter((k) => !before.has(k)).map((k) => name(after.get(k)));
  const removed = [...before.keys()].filter((k) => !after.has(k)).map((k) => name(before.get(k)));
  let changed = 0;
  for (const [k, r] of after) {
    const o = before.get(k);
    if (o != null && JSON.stringify(o) !== JSON.stringify(r)) changed++;
  }
  return { label: f.label, before: before.size, after: after.size, added, removed, changed };
}

function restorePrev() {
  for (const f of FILES) fs.copyFileSync(path.join(PREV, f.file), path.join(DIR, f.file));
}

async function main() {
  const { alertAdmin, escapeHtml } = await import("../src/services/email");
  const e = escapeHtml;
  const list = (xs: string[]) =>
    xs.length === 0
      ? "없음"
      : xs.slice(0, 20).map(e).join("<br />") + (xs.length > 20 ? `<br />… 외 ${xs.length - 20}곳` : "");

  if ((process.env.DATA_GO_KR_KEY ?? "") === "") {
    await alertAdmin("[마이오닥] 명부 갱신 실패", "<p>서버에 DATA_GO_KR_KEY 가 없어 명부를 받지 못했습니다.</p>");
    process.exitCode = 1;
    return;
  }

  // 처음이면 저장소 명부로 시작한다. 지난 회차 것을 prev 에 남겨 비교와 되돌리기에 쓴다.
  fs.mkdirSync(PREV, { recursive: true });
  for (const f of FILES) {
    const cur = path.join(DIR, f.file);
    if (!fs.existsSync(cur)) fs.copyFileSync(path.join(SEED, f.file), cur);
    fs.copyFileSync(cur, path.join(PREV, f.file));
  }

  let diffs: Diff[];
  try {
    const { fetchFacilities } = await import("./fetch-facilities");
    await fetchFacilities();
    diffs = FILES.map(diffOf);
  } catch (err) {
    restorePrev();
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[명부] 받기 실패", msg);
    await alertAdmin(
      "[마이오닥] 명부 갱신 실패",
      `<p>공공 API 에서 명부를 받지 못해 이번 주는 반영하지 않았습니다. 지난주 명부가 그대로입니다.</p>
       <p>사유: ${e(msg)}</p>`,
    );
    process.exitCode = 1;
    return;
  }

  const over = diffs.filter(
    (d) => d.removed.length / d.before > MAX_REMOVED || d.added.length / d.before > MAX_ADDED,
  );
  if (over.length > 0) {
    restorePrev();
    const why = over
      .map(
        (d) =>
          `${d.label}: 기존 ${d.before}곳 중 사라진 곳 ${d.removed.length}, 새로 생긴 곳 ${d.added.length}`,
      )
      .join("<br />");
    console.error("[명부] 변화가 너무 커서 멈춘다", why);
    await alertAdmin(
      "[마이오닥] 명부 갱신을 멈췄습니다 (확인 필요)",
      `<p>이번 주 공공 명부의 변화가 평소보다 커서 자동 반영을 멈췄습니다. 지난주 명부가 그대로입니다.</p>
       <p>${why}</p>
       <p>공공 API 가 일시적으로 이상한 경우가 많습니다. 다음 주에 다시 시도합니다. 계속 멈추면 개발 담당에게 알려 주세요.</p>`,
    );
    process.exitCode = 1;
    return;
  }

  const { importFacilities } = await import("./import-facilities");
  let result: Awaited<ReturnType<typeof importFacilities>>;
  try {
    result = await importFacilities();
  } catch (err) {
    // DB 반영이 중간에 끊겼다. 지난 회차 CSV 로 되돌려 두면 다음 회차가 같은
    // 변화를 다시 계산해 처음부터 넣는다(upsert 라 두 번 넣어도 같다).
    restorePrev();
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[명부] DB 반영 실패", msg);
    await alertAdmin(
      "[마이오닥] 명부 갱신 실패 (DB 반영)",
      `<p>명부는 받았지만 DB 에 넣는 중 오류가 나서 멈췄습니다. 다음 주에 다시 시도합니다.</p>
       <p>사유: ${e(msg)}</p>`,
    );
    process.exitCode = 1;
    return;
  }
  const skipped = [
    result.eye.skipped && `안과: ${result.eye.skipped}`,
    result.optical.skipped && `안경원: ${result.optical.skipped}`,
  ].filter(Boolean) as string[];

  const section = (d: Diff) => `
    <h3 style="margin:16px 0 4px">${d.label} ${d.after}곳</h3>
    <p style="margin:0">새로 생긴 곳 ${d.added.length} · 사라진 곳(폐업) ${d.removed.length} · 정보가 바뀐 곳 ${d.changed}</p>
    <p style="margin:6px 0 0;color:#555"><b>새로 생긴 곳</b><br />${list(d.added)}</p>
    <p style="margin:6px 0 0;color:#555"><b>사라진 곳</b><br />${list(d.removed)}</p>`;

  await alertAdmin(
    skipped.length > 0 ? "[마이오닥] 명부 갱신 (폐업 처리 보류)" : "[마이오닥] 이번 주 명부 갱신",
    `<p>공공 명부를 받아 반영했습니다.</p>
     ${skipped.length > 0 ? `<p style="color:#b3261e">폐업 처리는 보류했습니다: ${e(skipped.join(" / "))}</p>` : ""}
     ${diffs.map(section).join("")}`,
  );
  console.log("[명부] 반영 끝", diffs.map((d) => `${d.label} +${d.added.length} -${d.removed.length} ~${d.changed}`).join(", "));
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });
