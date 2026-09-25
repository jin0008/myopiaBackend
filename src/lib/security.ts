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

/**
 * 로그인 없이 받는 쓰기 경로용 - 지금은 광고 문의 하나다.
 *
 * lookupLimiter 보다 훨씬 빡빡하다. 사람이 문의를 넣는 일은 몇 분에 한 번도
 * 잦은 편인데, 봇은 초당 수십 건을 넣는다. 한 회사에서 여러 명이 같은 망으로
 * 넣는 경우를 생각해 시간당 5건은 남겨 둔다.
 */
export const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "문의가 너무 잦습니다. 잠시 후 다시 시도해 주세요." },
});
