import express from "express";
import { protect } from "../../middlewares/auth";
import { upload } from "../../utils/s3Upload";
import {
  adminCloseWarrantyClaim,
  confirmWarrantyResolution,
  declineWarrantyClaim,
  escalateWarrantyClaim,
  getAdminWarrantyAnalytics,
  getWarrantyClaimByBooking,
  getWarrantyClaimById,
  listAdminWarrantyClaims,
  listMyWarrantyClaims,
  markWarrantyResolved,
  openWarrantyClaim,
  respondToWarrantyProposal,
  submitWarrantyProposal,
  uploadWarrantyEvidence,
} from "../../handlers/WarrantyClaim";

const router = express.Router();

router.use(protect);

router.post("/upload-evidence", upload.array("files", 10), uploadWarrantyEvidence);
router.post("/", openWarrantyClaim);
router.get("/my", listMyWarrantyClaims);

router.get("/admin/list", listAdminWarrantyClaims);
router.get("/admin/analytics", getAdminWarrantyAnalytics);
router.post("/admin/:claimId/close", adminCloseWarrantyClaim);

router.get("/booking/:bookingId", getWarrantyClaimByBooking);
router.get("/:claimId", getWarrantyClaimById);
router.post("/:claimId/proposal", submitWarrantyProposal);
router.post("/:claimId/decline", declineWarrantyClaim);
router.post("/:claimId/proposal-response", respondToWarrantyProposal);
router.post("/:claimId/resolve", markWarrantyResolved);
router.post("/:claimId/confirm", confirmWarrantyResolution);
router.post("/:claimId/escalate", escalateWarrantyClaim);

export default router;
