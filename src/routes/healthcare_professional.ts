import express from "express";
import prisma from "../lib/prisma";
import { normalizeNameKo } from "../lib/hospitalName";
import { ADMIN_URL, alertAdmin, escapeHtml } from "../services/email";
import zod from "zod";

import { WrongArgumentsMessage } from "../lib/session";
import {
  approvedProfessionalRequired,
  loginRequired,
  siteAdminRequired,
} from "../lib/middlewares";

const router = express.Router();

const existingHospitalType = zod.object({
  id: zod.string().uuid(),
});

const newHospitalType = zod.object({
  name: zod.string().nonempty(),
  // 한글 표시 이름(선택). 비워 두면 name 을 그대로 쓴다.
  name_ko: zod.string().max(100).nullable().optional(),
  country_id: zod.string().uuid(),
  code: zod.string().regex(/^[a-zA-Z0-9]{1,10}$/),
});

const postType = zod.object({
  name: zod.string().nonempty(),
  country_id: zod.string().uuid(),
  hospital: zod.union([existingHospitalType, newHospitalType]),
  role: zod.string(),
  default_ethnicity_id: zod.string().uuid().nullable().optional(),
  default_instrument_id: zod.string().uuid().nullable().optional(),
});

router.post("/", loginRequired, async (req, res) => {
  const body = req.body;

  let data;

  try {
    data = postType.parse(body);
  } catch {
    res.status(400).json(WrongArgumentsMessage);
    return;
  }

  const existingHospital = existingHospitalType.safeParse(data.hospital);
  if (existingHospital.success) {
    await prisma.healthcare_professional.create({
      data: {
        user_id: req.authSession!.user_id,
        name: data.name,
        country_id: data.country_id,
        hospital_id: existingHospital.data.id,
        role: data.role,
        default_ethnicity_id: data.default_ethnicity_id,
        default_instrument_id: data.default_instrument_id,
      },
    });
    res.sendStatus(201);
    return;
  }

  // 병원을 새로 만든 사람이 그 병원의 관리자가 된다. 다만 사이트 관리자가
  // 승인하기 전에는 아무것도 못 한다 - 승인 없이 열면 누구나 실제 안과 이름으로
  // 병원을 만들어 환자를 등록하고 보호자에게 그 병원 이름으로 연동 초대를
  // 보낼 수 있다. 승인은 어드민 마이오피아 화면의 병원 직원 목록에서 한다.
  const newHospital = newHospitalType.safeParse(data.hospital);
  if (newHospital.success) {
    await prisma.healthcare_professional.create({
      data: {
        user: {
          connect: {
            id: req.authSession!.user_id,
          },
        },
        name: data.name,
        country: {
          connect: {
            id: data.country_id,
          },
        },
        hospital: {
          create: {
            name: newHospital.data.name,
            name_ko: normalizeNameKo(
              newHospital.data.name_ko,
              newHospital.data.name,
            ),
            country_id: newHospital.data.country_id,
            code: newHospital.data.code,
          },
        },
        approved: false,
        is_admin: true,
        role: data.role,
        default_ethnicity:
          data.default_ethnicity_id == null
            ? undefined
            : {
                connect: {
                  id: data.default_ethnicity_id,
                },
              },
        default_instrument:
          data.default_instrument_id == null
            ? undefined
            : {
                connect: {
                  id: data.default_instrument_id,
                },
              },
      },
    });
    res.sendStatus(201);

    alertNewHospital(req.authSession!.user_id, newHospital.data, data.name, data.role);
  }
});

const patchType = zod.object({
  default_ethnicity_id: zod.string().nullable().optional(),
  default_instrument_id: zod.string().nullable().optional(),
  role: zod.string().optional(),
});

router.patch("/", approvedProfessionalRequired, async (req, res) => {
  const body = req.body;

  let data;
  try {
    data = patchType.parse(body);
  } catch {
    res.sendStatus(400);
    return;
  }

  await prisma.healthcare_professional.update({
    where: {
      user_id: req.authSession!.user_id,
    },
    data: data,
  });

  res.sendStatus(200);
});

const patchHospitalType = zod.union([existingHospitalType, newHospitalType]);

router.patch("/hospital", approvedProfessionalRequired, async (req, res) => {
  const data = patchHospitalType.safeParse(req.body);
  if (!data.success) {
    res.status(400).json(WrongArgumentsMessage);
    return;
  }
  const hospitalData = data.data;

  const existingHospital = existingHospitalType.safeParse(hospitalData);
  if (existingHospital.success) {
    await prisma.healthcare_professional.update({
      where: {
        user_id: req.authSession!.user_id,
      },
      data: {
        hospital: {
          connect: {
            id: existingHospital.data.id,
          },
        },
        approved: false,
        is_admin: false,
      },
    });
    res.sendStatus(200);
    return;
  }

  const newHospital = newHospitalType.safeParse(hospitalData);
  if (newHospital.success) {
    await prisma.healthcare_professional.update({
      where: {
        user_id: req.authSession!.user_id,
      },
      data: {
        hospital: {
          create: {
            name: newHospital.data.name,
            name_ko: normalizeNameKo(
              newHospital.data.name_ko,
              newHospital.data.name,
            ),
            country_id: newHospital.data.country_id,
            code: newHospital.data.code,
          },
        },
        // 소속을 새 병원으로 옮겨도 승인부터 다시 받는다. 여기서 바로 승인하면
        // 어느 병원에서든 한 번 승인받은 계정이 가짜 병원을 만들 수 있다.
        approved: false,
        is_admin: true,
      },
    });
    res.sendStatus(200);
    alertNewHospital(req.authSession!.user_id, newHospital.data, req.healthcare_professional!.name, req.healthcare_professional!.role);
  }
});

const hospitalMemberPatchTypeAdmin = zod.object({
  approved: zod.boolean().optional(),
  is_admin: zod.boolean().optional(),
});
router.patch(
  "/:healthcare_professional_id",
  siteAdminRequired,
  async (req, res) => {
    const body = req.body;

    let data;
    try {
      data = hospitalMemberPatchTypeAdmin.parse(body);
    } catch {
      res.sendStatus(400);
      return;
    }

    await prisma.healthcare_professional
      .update({
        where: {
          user_id: String(req.params.healthcare_professional_id),
        },
        data: data,
      })
      .then(() => res.sendStatus(200));
  },
);

router.delete(
  "/:healthcare_professional_id",
  loginRequired,
  siteAdminRequired,
  async (req, res) => {
    await prisma.healthcare_professional
      .delete({
        where: {
          user_id: String(req.params.healthcare_professional_id),
        },
      })
      .then(() => res.sendStatus(200));
  },
);

/**
 * 새 병원 승인 요청을 운영자에게 알린다. 응답과 따로 간다 - 메일이나 조회가
 * 실패해도 병원 등록은 이미 끝났고, 관리자 페이지에서 보인다.
 */
function alertNewHospital(
  userId: string,
  hospital: { name: string; name_ko?: string | null; code: string },
  staffName: string,
  role: string,
): void {
  prisma.user
    .findUnique({ where: { id: userId }, select: { email: true } })
    .then((who) =>
      alertAdmin(
        `[마이오피아] 새 병원 승인 요청: ${hospital.name}`,
        `<p>새 병원이 등록되어 승인을 기다립니다.</p>
<ul>
<li>병원: ${escapeHtml(hospital.name)}${hospital.name_ko ? ` (${escapeHtml(hospital.name_ko)})` : ""}, 코드 ${escapeHtml(hospital.code)}</li>
<li>신청자: ${escapeHtml(staffName)} (${escapeHtml(role)}), ${escapeHtml(who?.email ?? "이메일 없음")}</li>
</ul>
<p>실제 병원과 신청자를 확인한 뒤 <a href="${ADMIN_URL}/myopia">관리자 페이지</a>에서 그 병원의 직원 목록을 열어 승인하거나 거절해 주세요.</p>`,
      ),
    )
    .catch((err) => console.error("[알림] 새 병원 알림을 보내지 못했다", err));
}

export default router;
