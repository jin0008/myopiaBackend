/**
 * 네이버 카페(cafe.naver.com/myodoc) 글을 전문가 칼럼으로 옮긴다.
 *
 *   npx tsx scripts/import-naver-cafe.ts          # DB 에 넣는다
 *   npx tsx scripts/import-naver-cafe.ts --dry    # 변환한 마크다운만 찍는다
 *
 * 카페 글은 slug cafe_<글번호> 로 알아보고 덮어쓴다. 카페에서 글을 고치거나
 * 새로 쓰면 다시 돌리면 된다. 공개 여부(published)는 건드리지 않는다 -
 * 관리자 화면에서 내린 글이 다시 올라오면 안 된다.
 *
 * 이미지는 받아서 uploads/columns 에 둔다. 카페 이미지(pstatic)는 우리
 * 도메인에서 걸면 403 이다.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import prisma from "../src/lib/prisma";

const CLUB_ID = 31765206;
const DRY = process.argv.includes("--dry");
const UPLOAD_DIR = path.join(__dirname, "../uploads/columns");
const PUBLIC_BASE = "https://myopiamanage.org/api/column/uploads";
const HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://cafe.naver.com/myodoc" };

// 카페 게시판 → 칼럼 분류. 앱은 분류를 보이지 않고 /columns?category= 로만 쓴다.
const MENU_CATEGORY: Record<string, string> = {
  "아트로핀 치료": "atropine",
  드림렌즈: "orthok",
  근시조절안경: "myopia_lenses",
  "마이사이트 렌즈": "myopia_lenses",
  "근시관리~": "lifestyle",
  "근시란?": "basics",
  "사시란?": "strabismus",
};
// 게시판 이름과 내용이 어긋나는 글.
const ARTICLE_CATEGORY: Record<number, string> = {
  5: "checkup", // 안축장
  12: "checkup", // 산동검사
  23: "basics", // 치료 언제 시작
  24: "basics", // 치료 언제 멈춤
  30: "basics", // 진행 속도
};
const CATEGORY_EMOJI: Record<string, string> = {
  atropine: "💧",
  orthok: "🌙",
  myopia_lenses: "👓",
  lifestyle: "☀️",
  basics: "👁️",
  checkup: "📏",
  strabismus: "👀",
};

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function unescape(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** 문단 하나의 안쪽 HTML → 인라인 마크다운. */
function inline(html: string): string {
  const md = html
    .replace(/\u200b/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    // 굵게만 남긴다. 칼럼 렌더러는 기울임 안의 굵게 같은 겹침을 못 그린다.
    .replace(/<\/?(span|i|u)( [^>]*)?>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis, (_, href, t) => {
      const url = unescape(href);
      const text = unescape(t.replace(/<[^>]+>/g, "")).trim();
      return !text || text === url ? url : `[${text}](${url})`;
    })
    // "<b>굵게 </b>" 의 빈칸을 밖으로 - 두면 "**굵게 **" 가 된다.
    .replace(/<(b|strong)>(\s+)/gi, "$2<$1>")
    .replace(/(\s+)<\/(b|strong)>/gi, "</$2>$1")
    .replace(/<\/?(b|strong)>/gi, "**")
    .replace(/<[^>]+>/g, "");
  return unescape(md)
    .replace(/\*{4}/g, "") // </b><b> 이어 붙은 자리, 빈 <b></b>
    .replace(/\s+/g, " ")
    .trim();
}

const plain = (html: string) => inline(html).replace(/\*\*/g, "").trim();

function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p class="se-text-paragraph[^>]*>(.*?)<\/p>/gs)].map((m) => m[1]);
}

/** 문단 하나 → 블록. 통째로 굵고 큰 글씨면 소제목으로 본다. */
function textBlock(p: string): string {
  const md = inline(p);
  if (!md) return "";
  const allBold = /^\*\*[^*]+\*\*$/.test(md);
  if (allBold && /se-fs-fs24/.test(p)) return `## ${plain(p)}`;
  if (allBold && /se-fs-fs(19|15)/.test(p) && md.length <= 64) return `### ${plain(p)}`;
  return md;
}

function tableBlock(html: string): string {
  const rows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((r) =>
    [...r[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((td) =>
      paragraphs(td[1]).map(inline).filter(Boolean).join(" ").replace(/\|/g, "／"),
    ),
  );
  if (rows.length === 0) return "";
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(rows[0]), line(rows[0].map(() => "---")), ...rows.slice(1).map(line)].join("\n");
}

async function saveImage(src: string): Promise<string | null> {
  if (DRY) return src;
  // 카페 원본은 수 MB 라 폭 800 짜리를 받는다.
  const url = /pstatic\.net/.test(src) && !src.includes("?") ? `${src}?type=w800` : src;
  const base = "cafe_" + crypto.createHash("sha1").update(src).digest("hex").slice(0, 16);
  const hit = fs.readdirSync(UPLOAD_DIR).find((f) => f.startsWith(base + "."));
  if (hit) return `${PUBLIC_BASE}/${hit}`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    const type = res.headers.get("content-type") ?? "";
    const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" }[
      type.split(";")[0]
    ];
    if (!res.ok || !ext) throw new Error(`${res.status} ${type}`);
    fs.writeFileSync(path.join(UPLOAD_DIR, base + ext), Buffer.from(await res.arrayBuffer()));
    return `${PUBLIC_BASE}/${base}${ext}`;
  } catch (e) {
    console.warn(`  ! 이미지 못 받음 ${src}: ${(e as Error).message}`);
    return null;
  }
}

/** 스마트에디터 본문 → 칼럼 마크다운. */
async function toMarkdown(html: string, id: number): Promise<string> {
  const blocks: string[] = [];
  for (const comp of html.split(/(?=<div class="se-component se-)/).slice(1)) {
    const kind = /^<div class="se-component se-(\w+)/.exec(comp)![1];
    const body = comp.replace(/<script[\s\S]*?<\/script>/g, "");
    if (kind === "text") {
      blocks.push(...paragraphs(body).map(textBlock));
    } else if (kind === "quotation") {
      // 카페에서는 인용구를 소제목 상자로 쓴다. 짧으면 소제목, 길면 강조 상자.
      const ps = paragraphs(body).map(inline).filter(Boolean);
      const one = ps.join(" ").replace(/\*\*/g, "");
      blocks.push(ps.length === 1 && one.length <= 40 ? `## ${one}` : ps.map((x) => `> ${x}`).join("\n"));
    } else if (kind === "image" || kind === "imageStrip") {
      for (const m of comp.matchAll(/"src"\s*:\s*"([^"]+)"/g)) {
        const url = await saveImage(unescape(m[1]));
        if (url) blocks.push(`![](${url})`);
      }
    } else if (kind === "table") {
      blocks.push(tableBlock(body));
    } else if (kind === "oglink") {
      const href = /href="([^"]+)"/.exec(body)?.[1];
      const title = /se-oglink-title">(.*?)</s.exec(body)?.[1];
      if (href) blocks.push(`[${unescape(title ?? href).trim()}](${unescape(href)})`);
    } else if (kind !== "horizontalLine") {
      console.warn(`  ! ${id}: 모르는 블록 ${kind} 건너뜀`);
    }
  }
  return blocks.filter(Boolean).join("\n\n");
}

/** 본문 첫 줄이 제목을 되풀이하는 소제목이면 뺀다 - 앱이 제목을 따로 그린다. */
function dropTitleEcho(body: string, title: string): string {
  const [first, ...rest] = body.split("\n\n");
  return first.replace(/^#+\s*/, "") === title ? rest.join("\n\n") : body;
}

async function main() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ids: number[] = [];
  for (let page = 1; ; page++) {
    const r = await getJson(
      `https://apis.naver.com/cafe-web/cafe2/ArticleListV2dot1.json?search.clubid=${CLUB_ID}` +
        `&search.queryType=lastArticle&search.page=${page}&search.perPage=50`,
    );
    const list = r.message.result.articleList as { articleId: number }[];
    ids.push(...list.map((a) => a.articleId));
    if (list.length < 50) break;
  }
  console.warn(`카페 글 ${ids.length}편`);

  for (const id of ids) {
    const a = (
      await getJson(
        `https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${CLUB_ID}/articles/${id}?useCafeId=true`,
      )
    ).result.article;
    const menu: string = a.menu?.name ?? "";
    const category = ARTICLE_CATEGORY[id] ?? MENU_CATEGORY[menu];
    if (category == null) {
      console.warn(`  ! ${id}: 게시판 "${menu}" 은 칼럼이 아니라 건너뜀`);
      continue;
    }
    const title = unescape(a.subject).trim();
    const body = dropTitleEcho(await toMarkdown(a.contentHtml, id), title);
    if (DRY) {
      console.log(`\n\n======== cafe_${id} [${category}] ${title}\n\n${body}`);
      continue;
    }
    const data = { title, body, category, thumbnail_emoji: CATEGORY_EMOJI[category] ?? "📄" };
    await prisma.expert_column.upsert({
      where: { slug: `cafe_${id}` },
      create: { slug: `cafe_${id}`, ...data, published_at: new Date(a.writeDate) },
      update: { ...data, updated_at: new Date() },
    });
    console.warn(`  ✓ ${id} ${title}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
