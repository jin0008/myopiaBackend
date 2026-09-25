/**
 * 광고 문의 접수의 스팸 방어가 실제로 동작하는지 본다.
 *
 *   npx tsx scripts/check-ad-inquiry.ts
 *
 * 허니팟은 걸렸을 때 201 로 조용히 삼켜야 한다. 400 을 주면 봇이 무엇에
 * 걸렸는지 알고 다음엔 그 칸을 비우고 온다. zod 에서 먼저 막으면 이 처리가
 * 실행되지 않는데, 눈으로는 구분이 안 된다.
 *
 * DB 를 타지 않는 경로만 본다 - 허니팟은 저장 전에 끝나고, 잘못된 본문은
 * 검증에서 끝난다.
 */
import assert from "assert";
import express from "express";
import adInquiry from "../src/routes/adInquiry";

const app = express();
app.use(express.json());
app.use("/ad-inquiry", adInquiry);

const valid = {
  kind: "eye", org: "테스트안과", contactName: "홍길동",
  phone: "010-1111-2222", email: "a@b.co", agreed: true,
};

const srv = app.listen(0, async () => {
  const port = (srv.address() as { port: number }).port;
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${port}/ad-inquiry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const empty = await post({});
  assert.strictEqual(empty.status, 400, "빈 본문은 400 이어야 한다");

  const noAgree = await post({ ...valid, agreed: false });
  assert.strictEqual(noAgree.status, 400, "동의 없이는 받지 않는다");

  const badEmail = await post({ ...valid, email: "not-an-email" });
  assert.strictEqual(badEmail.status, 400, "이메일 형식을 본다");

  // 핵심: 허니팟은 DB 를 타기 전에 201 로 끝난다.
  const bot = await post({ ...valid, website: "http://spam.example" });
  assert.strictEqual(bot.status, 201, "허니팟에 걸린 요청은 조용히 201 이어야 한다");

  console.log("ok — 허니팟은 조용히 삼키고, 잘못된 입력은 400 이다");
  srv.close();
});
