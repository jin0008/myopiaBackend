import rateLimit from "express-rate-limit";

/**
 * Brute-force / credential-stuffing protection for authentication endpoints.
 *
 * Only FAILED requests are counted (`skipSuccessfulRequests`), so a busy clinic
 * where many staff sign in from the same public IP is not affected by normal
 * use — only repeated failures from one IP are throttled. CORS preflight
 * (OPTIONS → 204) is treated as success and therefore not counted either.
 *
 * IMPORTANT: this keys on the client IP, which only works when Express is told
 * to trust the nginx reverse proxy — see `app.set("trust proxy", 1)` in
 * index.ts. Without it every request would appear to come from 127.0.0.1 and
 * a single attacker could lock out everyone.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // max 30 FAILED attempts per IP per window
  standardHeaders: true, // expose RateLimit-* headers
  legacyHeaders: false, // drop the deprecated X-RateLimit-* headers
  skipSuccessfulRequests: true, // successful logins do not count toward the limit
  message: {
    message:
      "Too many attempts from this network. Please wait a few minutes and try again.",
  },
});

/**
 * 조회만 하는 공개 엔드포인트용.
 *
 * authLimiter 는 실패한 요청만 세기 때문에(skipSuccessfulRequests) 여기에는
 * 쓸 수 없다. 아이디 사용 가능 확인은 성공해도 정보를 내주므로, 성공까지
 * 세지 않으면 제한이 아무 일도 하지 않는다.
 */
export const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 사람이 타이핑하며 쓰기엔 넉넉하고, 목록을 훑기엔 모자라다
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요." },
});
