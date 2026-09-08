import crypto from "node:crypto";

import prisma from "../lib/prisma";
import { sendEmail } from "./email";

/**
 * 병원이 부모에게 건네는 일회용 연동 초대.
 *
 * 지금까지는 부모가 병원 등록번호를 입력해 연동했다. 등록번호는 대개
 * 연속된 숫자라 비밀 노릇을 못 하고, 생년월일·성별만 맞으면 통과하므로
 * 순서대로 대입하면 남의 아이 진료 기록에 붙을 수 있었다.
 *
 * 추측할 수 있는 값을 묻는 대신, 병원이 줄 수만 있는 표를 건넨다.
 */

/** 2주. 진료를 마치고 집에 가서 여는 시간까지는 넉넉히, 잊고 지난 링크가
 *  몇 달씩 살아 있지는 않게. */
const TTL_DAYS = 14;

const WEB_ORIGIN = process.env.MYODOC_WEB_ORIGIN ?? "https://myodoc.co.kr";

/** 토큰은 해시로만 저장한다. DB 를 들여다봐도 링크를 되만들 수 없어야 한다. */
export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreatedInvite {
  /** 이 값은 지금 한 번만 존재한다. 저장하지 않는다. */
  token: string;
  url: string;
  expiresAt: Date;
}

export async function createLinkInvite(params: {
  hospitalId: string;
  patientId: string;
  createdBy: string;
  sentTo?: string | null;
}): Promise<CreatedInvite> {
  // 32바이트. 대입으로 맞힐 수 있는 크기가 아니다.
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.child_link_invite.create({
    data: {
      hospital_id: params.hospitalId,
      patient_id: params.patientId,
      token_hash: hashInviteToken(token),
      created_by: params.createdBy,
      expires_at: expiresAt,
      sent_to: params.sentTo ?? null,
    },
  });

  // 웹 주소로 건넨다. 앱이 없는 부모도 열어서 안내를 볼 수 있어야 한다.
  return { token, url: `${WEB_ORIGIN}/link/${token}`, expiresAt };
}

export type InviteProblem = "not_found" | "expired" | "used" | "revoked";

/**
 * 토큰을 확인한다.
 *
 * 왜 쓸 수 없는지를 구분해 돌려준다 - "만료됐습니다"와 "이미 사용됐습니다"는
 * 부모가 해야 할 일이 다르다(다시 받기 vs 이미 연동됨). 토큰을 모르는
 * 사람에게는 어차피 not_found 하나만 보이므로 구분이 정보를 흘리지 않는다.
 */
export async function resolveInvite(token: string) {
  const invite = await prisma.child_link_invite.findUnique({
    where: { token_hash: hashInviteToken(token) },
    include: {
      hospital: { select: { id: true, name: true, code: true } },
      patient: { select: { id: true, sex: true, encrypted_date_of_birth: true } },
    },
  });
  if (invite == null) return { problem: "not_found" as const };
  if (invite.revoked_at != null) return { problem: "revoked" as const };
  if (invite.used_at != null) return { problem: "used" as const };
  if (invite.expires_at.getTime() < Date.now()) {
    return { problem: "expired" as const };
  }
  return { invite };
}

/** 초대 메일.
 *
 *  받는 사람은 병원에서 방금 안내를 들은 부모다. 무엇을 눌러야 하는지가
 *  한눈에 보여야 하고, 링크가 언제까지 유효한지를 밝혀야 한다.
 *
 *  아이 이름이나 등록번호는 넣지 않는다. 메일은 잘못 간 주소에 도착할 수
 *  있고, 그때 누구의 진료 기록인지 알려주게 된다.
 */
export async function sendInviteEmail(params: {
  to: string;
  hospitalName: string;
  url: string;
  expiresAt: Date;
}): Promise<void> {
  const until = params.expiresAt.toISOString().slice(0, 10);
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;
                max-width:520px;margin:0 auto;padding:32px 24px;color:#111">
      <p style="font-size:13px;color:#666;margin:0 0 8px">마이오닥</p>
      <h1 style="font-size:20px;margin:0 0 16px">아이 진료 기록 연동 안내</h1>
      <p style="font-size:15px;line-height:1.7;margin:0 0 24px">
        <b>${escapeHtml(params.hospitalName)}</b>에서 아이의 진료 기록을
        마이오닥 앱에 연동할 수 있는 링크를 보냈습니다.
        아래 버튼을 누르면 앱에서 연동이 진행됩니다.
      </p>
      <a href="${params.url}"
         style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;
                padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px">
        연동하기
      </a>
      <p style="font-size:13px;color:#666;line-height:1.7;margin:24px 0 0">
        이 링크는 <b>${until}</b>까지 유효하며 한 번만 사용할 수 있습니다.<br />
        본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다.
      </p>
    </div>`;
  await sendEmail([params.to], "[마이오닥] 아이 진료 기록 연동 안내", html);
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
