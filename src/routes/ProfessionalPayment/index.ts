import { Router } from "express";
import { getPaymentStats, getTransactions } from "../../handlers/Professional/payments";
import { authMiddleware, protect } from "../../middlewares/auth";

const professionalPaymentRouter = Router();

professionalPaymentRouter.get(
  "/payment-stats",
  protect,
  authMiddleware(["professional"]),
  getPaymentStats
);

professionalPaymentRouter.get(
  "/transactions",
  protect,
  authMiddleware(["professional"]),
  getTransactions
);

export default professionalPaymentRouter;

