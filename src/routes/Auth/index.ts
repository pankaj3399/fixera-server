import { Router } from "express";
import { LogIn, SignUp, LogOut, getMe } from "../../handlers/Auth";
import { protect } from "../../middlewares/auth";

const authRouter = Router();

authRouter.route('/signup').post(SignUp);
authRouter.route('/login').post(LogIn);
authRouter.route('/logout').post(LogOut);
authRouter.route('/me').get(protect,getMe);

export default authRouter