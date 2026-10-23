/**
 * 개인정보처리방침에 AI 상담 대화는 1년 보관으로 적었다. 대화 기록(chat-날짜.jsonl)과
 * 사용자 id 가 든 하루 사용량(usage-날짜.json)을, 날짜가 1년 넘게 지난 것부터 지운다.
 * 하루 한 번, 그날 첫 기록을 남길 때 한다.
 */
export function expiredChatFiles(names: string[], today: string): string[] {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const limit = cutoff.toISOString().slice(0, 10);
  return names.filter((n) => {
    const m = /^(?:chat|usage)-(\d{4}-\d{2}-\d{2})\.jsonl?$/.exec(n);
    return m != null && m[1] < limit;
  });
}
