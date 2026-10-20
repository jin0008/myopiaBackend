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

/**
 * 카드 등록(빌키 발급)용.
 *
 * 훔친 카드번호를 맞춰 보는 창구로 쓰이기 쉬운 자리다 - 등록이 되면 살아
 * 있는 카드라는 뜻이라서. 로그인한 파트너만 오지만 계정 하나로도 수백 번
 * 돌릴 수 있으니 횟수를 묶는다. 사람이 오타로 몇 번 틀리는 것은 넉넉히 남긴다.
 */
export const billingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "카드 등록 시도가 너무 잦습니다. 한 시간 뒤에 다시 시도해 주세요." },
});

/**
 * 병원 환자 기록에 연결하는 자리용 - 웹 보호자 연결(/user/patient)과 앱 병원
 * 연동(/children/:childId/hospital-links).
 *
 * 등록번호와 생년월일만 맞으면 그 아이 차트가 열린다. 아이 생년월일은 몇천 가지라
 * 사람 단위로 세지 않으면 계정 하나로 다 대 볼 수 있다. IP 로 세면 공유기 하나
 * 뒤의 여러 집이 같이 막히고, 공격자는 IP 를 바꾸면 그만이다. 그래서 로그인한
 * 계정으로 센다 - 그래서 로그인 확인 뒤에 둬야 한다.
 *
 * 실패만 센다. 병원에서 받은 번호를 오타로 몇 번 틀리는 것은 넉넉히 남긴다.
 *
 * ponytail: 횟수는 메모리에 둔다 - 서버를 다시 띄우면(배포) 0 으로 돌아간다.
 * 서버가 둘이 되거나 배포가 잦아져 구멍이 되면 DB 나 Redis 저장소로.
 */
export const linkAttemptLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.mobileUser?.sub ?? req.authSession?.user_id ?? "anonymous",
  message: {
    error: "too many failed link attempts",
    code: "rate_limited",
    message: "연동 시도가 너무 많습니다. 내일 다시 시도하거나 병원에 초대 링크를 요청해 주세요.",
  },
});
