import express from "express";
import prisma from "../lib/prisma";
import { approvedProfessionalRequired } from "../lib/middlewares";
import { isPatientInHospital } from "../lib/authorization";

const router = express.Router();
router.use(approvedProfessionalRequired);

router.get("/patient/:patientId", async (req, res) => {
  const patientId = String(req.params.patientId);

  const authorized = await isPatientInHospital(
    patientId,
    req.healthcare_professional!.hospital_id,
  );
  if (!authorized) {
    res.sendStatus(403);
    return;
  }

  const logs = await prisma.audit_log.findMany({
    where: { patient_id: patientId },
    include: { actor: { select: { email: true } } },
    orderBy: { created_at: "desc" },
  });
  res.json(logs);
});

export default router;
