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

const BASE = process.env.NICEPAY_BASE_URL ?? "https://api.nicepay.co.kr";

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
 * 빌링키로 청구한다. 매달 이것을 부른다.
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
