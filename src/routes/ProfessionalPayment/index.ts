import { Router } from "express";
import { getPaymentStats, getTransactions } from "../../handlers/Professional/payments";
import { authMiddleware } from "../../middlewares/auth";

const professionalPaymentRouter = Router();

professionalPaymentRouter.get(
  "/payment-stats",
  authMiddleware(["professional"]),
  getPaymentStats
);

professionalPaymentRouter.get(
  "/transactions",
  authMiddleware(["professional"]),
  getTransactions
);

export default professionalPaymentRouter;
