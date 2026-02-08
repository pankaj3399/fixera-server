import User from "../models/user";
import { sendIdExpiredEmail } from "./emailService";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const runIdExpiryCheck = async () => {
  try {
    const now = new Date();
    const expiredUsers = await User.find({
      role: "professional",
      idExpirationDate: { $exists: true, $ne: null, $lte: now },
      $or: [
        { idExpiryEmailSentAt: { $exists: false } },
        { idExpiryEmailSentAt: null }
      ]
    }).select("email name idExpirationDate idExpiryEmailSentAt");

    if (expiredUsers.length === 0) return;

    for (const user of expiredUsers) {
      const emailSent = await sendIdExpiredEmail(user.email, user.name);
      if (emailSent) {
        user.idExpiryEmailSentAt = new Date();
        await user.save();
      }
    }
  } catch (error) {
    console.error("ID expiry email job failed:", error);
  }
};

export const startIdExpiryScheduler = () => {
  runIdExpiryCheck();
  setInterval(runIdExpiryCheck, ONE_DAY_MS);
};
