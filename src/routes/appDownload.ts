import express from "express";

/**
 * GET /app — 마이오닥 앱 다운로드 QR 하나가 가리키는 주소.
 *
 * 안드로이드·아이폰 QR 을 따로 두면 사람이 고르다 틀린다. QR 은 이 주소
 * 하나로 두고 기기에 맞는 스토어로 보낸다. 운영 주소는 nginx 가 /api 를 떼므로
 * https://myopiamanage.org/api/app 이다.
 *
 * myodoc.co.kr 에 두지 않은 건 그쪽 배포가 PG 심사 동안 묶여 있어서다.
 */
export const APP_STORE_URL = "https://apps.apple.com/kr/app/id6822126907";
export const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=org.myopiamanage.myodoc";

export function storeFor(userAgent: string): string | null {
  // iPadOS 사파리는 맥처럼 자기를 소개해 PC 안내로 간다. 안내 페이지에도
  // 두 스토어 링크가 있어 막히지는 않는다.
  if (/iPhone|iPad|iPod/i.test(userAgent)) return APP_STORE_URL;
  if (/Android/i.test(userAgent)) return PLAY_STORE_URL;
  return null;
}

const fallbackPage = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>마이오닥 앱 받기</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;
margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f7fb;color:#1a1f36}
main{text-align:center;padding:32px 16px}
h1{font-size:22px;margin:0 0 8px}p{color:#5a6178;margin:0 0 24px;line-height:1.5}
a{display:block;margin:10px auto;max-width:260px;padding:14px;border-radius:12px;background:#2f6bff;
color:#fff;text-decoration:none;font-weight:700}
</style></head><body><main>
<h1>마이오닥 앱</h1>
<p>휴대폰에서 이 QR 을 찍으면 스토어로 바로 이동합니다.<br>아래에서 직접 받을 수도 있어요.</p>
<a href="${APP_STORE_URL}">App Store (아이폰)</a>
<a href="${PLAY_STORE_URL}">Google Play (안드로이드)</a>
</main></body></html>`;

const router = express.Router();

router.get("/", (req, res) => {
  const store = storeFor(req.get("user-agent") ?? "");
  if (store != null) {
    // 302: 스토어 주소가 바뀌면 QR 은 그대로 두고 여기만 고친다. 301 은 브라우저가 기억한다.
    res.redirect(302, store);
    return;
  }
  res.type("html").send(fallbackPage);
});

export default router;
