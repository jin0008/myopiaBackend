/**
 * AI 상담 기록 보관 1년: 1년 넘게 지난 chat-·usage- 파일만 지울 대상으로 고른다.
 *   npx ts-node --transpile-only scripts/check-chat-retention.ts
 */
import assert from "assert";
import { expiredChatFiles } from "../src/lib/chatRetention";

const names = [
  "chat-2025-10-20.jsonl", // 1년 하루 넘음 → 지움
  "usage-2025-10-20.json", // 같음
  "chat-2025-10-21.jsonl", // 딱 1년 → 둔다
  "chat-2026-10-21.jsonl", // 오늘
  "qa_index.json", // 다른 파일은 건드리지 않는다
  "chat-notes.txt",
];
assert.deepEqual(expiredChatFiles(names, "2026-10-21"), ["chat-2025-10-20.jsonl", "usage-2025-10-20.json"]);
assert.deepEqual(expiredChatFiles(["chat-2024-02-29.jsonl"], "2025-02-28"), []); // 윤일: 1년 안
console.log("chat retention ok");
