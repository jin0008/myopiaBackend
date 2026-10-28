/**
 * 감수 원고의 출처.
 *
 * 원고(src/assets/chat/{qa,columns}/*.md)는 문항마다 끝에 한 줄로 출처를 단다.
 *   *참고: 라벨 https://… ; 라벨 https://… — [검수 필요: …]*
 * Apple 은 건강 정보에 출처가 보이지 않으면 반려한다(1.4.1). AI 상담과 칼럼이
 * 이 줄을 읽어 출처로 보인다.
 */
export type Citation = { title: string; url: string };

const REF_LINE = /^\*참고:\s*(.+?)\*\s*$/gm;

/** [검수 필요: …], [출처 상이: …] 는 감수자끼리 남긴 메모다. 독자에게 보이면
 *  검수가 덜 끝난 글로 읽힌다. */
const REVIEW_NOTE = /\s*(—\s*)?\[(검수 필요|출처 상이)[^\]]*\]/g;

export function stripReviewNotes(text: string): string {
  return text.replace(REVIEW_NOTE, "");
}

/** 본문의 *참고:* 줄을 출처 목록으로. 주소가 있는 것을 앞에 둔다. */
export function citationsOf(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(REF_LINE)) {
    for (const part of stripReviewNotes(m[1]).split(/\s;\s/)) {
      const p = part.trim();
      if (p === "") continue;
      const url = /https?:\/\/\S+/.exec(p)?.[0] ?? "";
      const title = url === "" ? p : p.replace(url, "").replace(/\s*—\s*$/, "").trim() || url;
      const key = url || title;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, url });
    }
  }
  return [...out.filter((c) => c.url !== ""), ...out.filter((c) => c.url === "")];
}
