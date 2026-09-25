/**
 * 폐업 판정의 안전장치가 실제로 막는지 본다.
 *
 *   npx tsx scripts/check-facility-closure.ts
 *
 * 주 1회 자동 갱신에서는 아무도 보고 있지 않다. 잘린 파일이 전국을
 * 폐업시키는 것만은 반드시 막아야 한다.
 */
import assert from "assert";
import { decideClosures } from "../src/lib/facilityClosure";

const open100 = Array.from({ length: 100 }, (_, i) => `k${i}`);

// 1) 정상: 한 곳만 빠지면 그 한 곳만 닫는다.
{
  const v = decideClosures(open100, [], open100.slice(1));
  assert.ok(v.ok, "1% 감소는 통과해야 한다");
  assert.deepStrictEqual(v.toClose, ["k0"]);
}

// 2) 한계 초과: 10% 가 사라지면 폐업 판정을 거부한다.
{
  const v = decideClosures(open100, [], open100.slice(10));
  assert.ok(!v.ok, "10% 감소는 막아야 한다");
  assert.strictEqual(v.disappeared, 10);
}

// 3) 빈 파일: 비율과 무관하게 언제나 거부한다.
{
  const v = decideClosures(open100, [], []);
  assert.ok(!v.ok, "빈 파일은 막아야 한다");
}

// 4) 첫 적재: 알던 곳이 없으면 비율을 재지 않는다.
{
  const v = decideClosures([], [], open100);
  assert.ok(v.ok, "첫 적재는 통과해야 한다");
  assert.deepStrictEqual(v.toClose, []);
}

// 5) 되살리기: 닫아 둔 곳이 다시 나오면 연다.
{
  const v = decideClosures(open100, ["gone1"], [...open100, "gone1"]);
  assert.ok(v.ok);
  assert.deepStrictEqual(v.toReopen, ["gone1"]);
}

// 6) 경계: 정확히 한계선(2%)은 통과시킨다 - 넘을 때만 막는다.
{
  const v = decideClosures(open100, [], open100.slice(2));
  assert.ok(v.ok, "정확히 2% 는 통과해야 한다");
}

console.log("ok — 잘린 파일은 막고, 정상 갱신은 통과한다");
