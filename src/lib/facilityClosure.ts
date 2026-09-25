/**
 * 명부 갱신에서 "이번 파일에 없는 곳"을 폐업으로 볼지 정한다.
 *
 * 이 판단은 위험하다. 파일이 잘렸는데 그대로 믿으면 전국이 한 번에 폐업
 * 처리된다. 자동 갱신(주 1회)에서는 아무도 보고 있지 않으므로, 믿을 수
 * 없는 파일은 폐업 판정만 건너뛰고 upsert 는 그대로 진행한다 - 새로 생긴
 * 곳과 바뀐 정보는 반영하되, 지우는 쪽만 보류하는 것이 안전한 실패다.
 */

/** 한 번에 사라질 수 있다고 보는 최대 비율. 2,042 곳이면 40 곳쯤이다.
 *  실제 폐업은 주 단위로 이만큼 나지 않는다 - 넘으면 자료 사고다. */
export const MAX_DISAPPEARED_RATIO = 0.02;

export type ClosureVerdict =
  | { ok: true; toClose: string[]; toReopen: string[] }
  | { ok: false; reason: string; disappeared: number; known: number };

/**
 * @param knownOpen  지금 DB 에서 영업 중인 키
 * @param knownClosed 지금 DB 에서 폐업으로 표시된 키
 * @param incoming   이번 파일에 들어온 키
 */
export function decideClosures(
  knownOpen: string[],
  knownClosed: string[],
  incoming: string[],
): ClosureVerdict {
  const seen = new Set(incoming);

  // 빈 파일은 언제나 사고다. 비율로 재기 전에 먼저 막는다 - 명부가
  // 비어 있을 리 없고, 0 곳을 받아들이면 전부 폐업이 된다.
  if (seen.size === 0) {
    return { ok: false, reason: "이번 파일에 기관이 하나도 없다", disappeared: knownOpen.length, known: knownOpen.length };
  }

  const toClose = knownOpen.filter((k) => !seen.has(k));

  // 알던 곳이 아직 없으면(첫 적재) 비교할 대상이 없다. 비율은 재지 않는다.
  if (knownOpen.length > 0) {
    const ratio = toClose.length / knownOpen.length;
    if (ratio > MAX_DISAPPEARED_RATIO) {
      return {
        ok: false,
        reason: `사라진 곳이 ${(ratio * 100).toFixed(1)}% 로 한계(${MAX_DISAPPEARED_RATIO * 100}%)를 넘는다`,
        disappeared: toClose.length,
        known: knownOpen.length,
      };
    }
  }

  // 닫았다고 표시해 둔 곳이 다시 파일에 나오면 되살린다. 폐업으로 잘못
  // 찍혔거나 실제로 다시 문을 연 경우다.
  const toReopen = knownClosed.filter((k) => seen.has(k));

  return { ok: true, toClose, toReopen };
}
