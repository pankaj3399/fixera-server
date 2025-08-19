import { Router } from "express";

import { sendEmailOTP,verifyEmailOTP,resendEmailOTP } from "../../../handlers/User/verify/email/index";
const router = Router();

// Send OTP to user's email
router.post("/send-otp", sendEmailOTP);

// Verify email OTP
router.post("/verify-otp", verifyEmailOTP);

// Resend OTP
router.post("/resend-otp", resendEmailOTP);

export default router;
