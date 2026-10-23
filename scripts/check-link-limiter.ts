/**
 * linkAttemptLimiter 확인: 계정마다 실패 10번까지 받고 11번째를 429 로 막는다.
 * 성공은 세지 않고, 다른 계정은 따로 센다.
 *   npx ts-node scripts/check-link-limiter.ts
 */
import assert from "assert";
import express from "express";
import { linkAttemptLimiter } from "../src/lib/security";

const app = express();
app.use((req, _res, next) => {
  (req as any).mobileUser = { sub: String(req.headers["x-user"]) };
  next();
});
app.post("/link", linkAttemptLimiter, (req, res) => {
  res.sendStatus(req.headers["x-ok"] ? 201 : 404);
});

async function main() {
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const hit = (user: string, ok = false) =>
    fetch(`http://127.0.0.1:${port}/link`, {
      method: "POST",
      headers: { "x-user": user, ...(ok ? { "x-ok": "1" } : {}) },
    }).then((r) => r.status);

  for (let i = 0; i < 5; i++) assert.equal(await hit("a", true), 201); // 성공은 안 센다
  for (let i = 0; i < 10; i++) assert.equal(await hit("a"), 404);
  assert.equal(await hit("a"), 429);
  assert.equal(await hit("a", true), 429); // 막힌 뒤에는 맞는 정보도 막는다
  assert.equal(await hit("b"), 404); // 다른 계정은 따로
  server.close();
  console.log("link limiter ok");
}
main();
