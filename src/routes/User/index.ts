import { Router } from "express";
import { VerifyPhone } from "../../handlers/User/verify/phone";
import { VerifyPhoneCheck } from "../../handlers/User/verify/phone";
import emailVerificationRoutes from "./verify/email";
import { protect } from "../../middlewares/auth";
import { GetCurrentUser } from "../../handlers";

const userRouter = Router();

userRouter.use(protect)

userRouter.route('/me').get(GetCurrentUser)
userRouter.route("/verify-phone").post(VerifyPhone)
userRouter.route("/verify-phone-check").post(VerifyPhoneCheck)
userRouter.use("/verify-email", emailVerificationRoutes);



export default userRouter;