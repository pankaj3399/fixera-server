import { Router } from "express";
import { LogIn, SignUp, LogOut, getMe, ForgotPassword, ResetPassword } from "../../handlers/Auth";
import { protect } from "../../middlewares/auth";

const authRouter = Router();

authRouter.route('/signup').post(SignUp);
authRouter.route('/login').post(LogIn);
authRouter.route('/logout').post(LogOut);
authRouter.route('/me').get(getMe); 
authRouter.route('/forgot-password').post(ForgotPassword);
authRouter.route('/reset-password').post(ResetPassword);

export default authRouter