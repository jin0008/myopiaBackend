/**
 * 나이스페이먼츠.
 *
 * 키는 환경변수로만 읽는다. 저장소에 넣지 않는다 - 시크릿 키 하나로
 * 결제 승인과 취소가 되므로, 새어 나가면 남의 결제를 취소하거나 위조
 * 승인을 넣을 수 있다.
 *
 *   NICEPAY_CLIENT_KEY
 *   NICEPAY_SECRET_KEY
 *   NICEPAY_BASE_URL   (기본: 운영. 테스트 상점을 받으면 그쪽으로)
 *
 * 카드번호는 우리가 들지 않는다. 빌링키(bid)만 받아 두고 청구할 때마다
 * 그것을 쓴다 - 카드번호를 들면 PCI 범위에 들어오고, 그럴 이유가 없다.
 */

import crypto from "crypto";

const BASE = process.env.NICEPAY_BASE_URL ?? "https://api.nicepay.co.kr";

/** 결제창에서 돌아온 거래를 승인할 때 보내는 서명.
 *  hex(sha256(tid + amount + ediDate + SecretKey)) — 나이스 문서 그대로다. */
function signApprove(tid: string, amount: number, ediDate: string): string {
  return crypto
    .createHash("sha256")
    .update(`${tid}${amount}${ediDate}${process.env.NICEPAY_SECRET_KEY ?? ""}`)
    .digest("hex");
}

/** 브라우저에 내려도 되는 값. 결제창을 여는 데 쓴다. */
export function clientKey(): string {
  return process.env.NICEPAY_CLIENT_KEY ?? "";
}

export function isConfigured(): boolean {
  return (
    (process.env.NICEPAY_CLIENT_KEY ?? "") !== "" &&
    (process.env.NICEPAY_SECRET_KEY ?? "") !== ""
  );
}

function authHeader(): string {
  const id = process.env.NICEPAY_CLIENT_KEY ?? "";
  const pw = process.env.NICEPAY_SECRET_KEY ?? "";
  return "Basic " + Buffer.from(`${id}:${pw}`).toString("base64");
}

/** 나이스가 돌려주는 공통 모양. resultCode "0000" 이 성공이다. */
export type NiceResult = {
  resultCode: string;
  resultMsg: string;
  tid?: string;
  bid?: string;
  orderId?: string;
  amount?: number;
  status?: string;
  payMethod?: string;
  paidAt?: string;
  [k: string]: unknown;
};

export class NiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call(path: string, body?: unknown): Promise<NiceResult> {
  if (!isConfigured()) {
    throw new NiceError("not_configured", "결제 설정이 아직 되어 있지 않습니다.");
  }
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // fetch 는 기본 시간 제한이 없다. 결제사가 응답을 안 주면 이 요청이
    // 영영 매달려 있고, 청구가 몰리는 시각에는 그런 것이 쌓인다.
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as NiceResult | null;
  if (json == null) {
    throw new NiceError("bad_response", "결제사 응답을 읽지 못했습니다.");
  }
  return json;
}

/** 성공이 아니면 던진다. 호출부가 매번 resultCode 를 보지 않게. */
function must(r: NiceResult): NiceResult {
  if (r.resultCode !== "0000") {
    throw new NiceError(r.resultCode, r.resultMsg || "결제에 실패했습니다.");
  }
  return r;
}

/**
 * 거래 조회.
 *
 * 웹훅이 왔을 때 몸통을 믿지 않고 이것으로 다시 확인한다. 웹훅은 밖에서
 * 아무나 쏠 수 있는 창구라, 거기 적힌 금액과 상태를 그대로 믿으면 공짜로
 * 구독을 켜는 길이 열린다. 서명을 맞춰 보는 방법도 있지만, 결제사에게
 * 다시 묻는 쪽이 어느 결제사를 쓰든 같은 답을 준다.
 */
export function getPayment(tid: string): Promise<NiceResult> {
  return call(`/v1/payments/${encodeURIComponent(tid)}`);
}

/**
 * 주문번호로 거래를 조회한다. orderDate 는 주문을 만든 날(YYYYMMDD).
 *
 * 청구 응답이 끊겼을 때 쓴다. 우리는 tid 를 못 받았지만 주문번호는 우리가
 * 만들었으니 안다.
 */
export function findPayment(orderId: string, orderDate: string): Promise<NiceResult> {
  return call(
    `/v1/payments/find/${encodeURIComponent(orderId)}?orderDate=${encodeURIComponent(orderDate)}`,
  );
}

/**
 * 결제창에서 인증을 마친 거래를 승인한다.
 *
 * 인증과 승인은 다른 단계다. 인증까지는 카드사가 "이 사람 맞다"고 한
 * 것이고, 돈은 승인에서 빠진다. 그래서 인증 결과만 보고 구독을 켜면
 * 돈을 안 받고 켜 주는 셈이 된다.
 *
 * 금액을 다시 보낸다. 우리가 적어 둔 금액으로 승인하므로, 결제창에서
 * 금액을 바꿔 넣어도 그 금액으로는 승인되지 않는다.
 */
export async function approvePayment(tid: string, amount: number): Promise<NiceResult> {
  const ediDate = new Date().toISOString();
  return must(
    await call(`/v1/payments/${encodeURIComponent(tid)}`, {
      amount,
      ediDate,
      signData: signApprove(tid, amount, ediDate),
    }),
  );
}

/** 빌키 발급에 보내는 카드 정보. 받는 즉시 암호화하고 어디에도 남기지 않는다. */
export type CardInput = {
  /** 숫자만. */
  cardNo: string;
  /** YY */
  expYear: string;
  /** MM */
  expMonth: string;
  /** 개인카드는 생년월일 6자리(YYMMDD), 법인카드는 사업자등록번호 10자리. */
  idNo: string;
  /** 비밀번호 앞 2자리. */
  cardPw: string;
};

/** 나이스가 정한 평문 모양. 순서와 이름이 문서 그대로여야 한다. */
export function cardPlain(c: CardInput): string {
  return (
    `cardNo=${c.cardNo}&expYear=${c.expYear}&expMonth=${c.expMonth}` +
    `&idNo=${c.idNo}&cardPw=${c.cardPw}`
  );
}

/**
 * encData. encMode A2 = AES-256-CBC, 키는 SecretKey 32바이트, IV 는 그
 * 앞 16자리, 결과는 hex. 문서 예시로 맞춰 본다(scripts/check-billing-enc.ts).
 *
 * 기본(AES-128-ECB) 대신 A2 를 쓴다. ECB 는 같은 평문이 같은 암호문이
 * 되어, 같은 카드를 두 번 보내면 밖에서도 같은 카드임을 알 수 있다.
 */
export function encryptCard(plain: string, secret = process.env.NICEPAY_SECRET_KEY ?? ""): string {
  if (secret.length !== 32) {
    throw new NiceError("bad_secret", "결제 키 길이가 32자가 아닙니다.");
  }
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(secret, "utf8"),
    Buffer.from(secret.slice(0, 16), "utf8"),
  );
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("hex");
}

/**
 * 카드를 등록하고 빌링키(bid)를 받는다.
 *
 * 카드 정보가 우리 서버를 거쳐 가는 유일한 자리다. 받은 값은 여기서
 * 암호화해 보내고 끝이다 - 저장하지 않고, 로그에도, 예외 메시지에도
 * 싣지 않는다. 남는 것은 나이스가 준 bid 뿐이다.
 *
 * 문서의 응답 예시는 키가 대문자(ResultCode, BID)이고 표는 소문자다. 둘 다
 * 받는다.
 */
export async function registerBilling(args: {
  orderId: string;
  card: CardInput;
  buyerName?: string;
}): Promise<{ bid: string; cardName: string | null; raw: NiceResult }> {
  const r = await call("/v1/subscribe/regist", {
    encData: encryptCard(cardPlain(args.card)),
    encMode: "A2",
    orderId: args.orderId,
    ...(args.buyerName ? { buyerName: args.buyerName } : {}),
  });
  const code = String(r.resultCode ?? r.ResultCode ?? "");
  const msg = String(r.resultMsg ?? r.ResultMsg ?? "");
  const bid = String(r.bid ?? r.BID ?? "");
  if (code !== "0000" || bid === "") {
    throw new NiceError(code || "regist_failed", msg || "카드를 등록하지 못했습니다.");
  }
  const cardName = r.cardName ?? r.CardName;
  return { bid, cardName: typeof cardName === "string" ? cardName : null, raw: r };
}

/**
 * 빌링키로 청구한다.
 *
 * orderId 는 우리가 만든다. 같은 번호로 두 번 부르면 나이스가 거절하므로,
 * 재시도가 두 번 청구로 번지지 않는다.
 */
export async function chargeBilling(args: {
  bid: string;
  orderId: string;
  amount: number;
  goodsName: string;
}): Promise<NiceResult> {
  return must(
    await call(`/v1/subscribe/${encodeURIComponent(args.bid)}/payments`, {
      orderId: args.orderId,
      amount: args.amount,
      goodsName: args.goodsName,
    }),
  );
}

/**
 * 빌링키를 지운다. 구독을 끊을 때.
 *
 * 끊는다고 바로 광고를 내리지는 않는다 - 이번 주기까지는 돈을 받았다.
 * 여기서는 다음 청구를 막는 것까지만 한다.
 */
export async function expireBilling(bid: string, orderId: string): Promise<NiceResult> {
  return must(
    await call(`/v1/subscribe/${encodeURIComponent(bid)}/expire`, { orderId }),
  );
}

/** 승인 취소(환불). 부분 취소는 amount 를 준다. */
export async function cancelPayment(args: {
  tid: string;
  reason: string;
  orderId: string;
  amount?: number;
}): Promise<NiceResult> {
  return must(
    await call(`/v1/payments/${encodeURIComponent(args.tid)}/cancel`, {
      reason: args.reason,
      orderId: args.orderId,
      ...(args.amount != null ? { amount: args.amount } : {}),
    }),
  );
}
