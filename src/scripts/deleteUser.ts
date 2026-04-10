import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/user";
import { deleteUserData } from "../utils/deleteUserData";

dotenv.config();

async function deleteUserByEmail(email: string) {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI not found in .env");
  }

  await mongoose.connect(mongoUri);

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    await mongoose.disconnect();
    process.exit(1);
  }

  await deleteUserData(user._id);
  await mongoose.disconnect();
}

const email = process.argv[2];
if (!email) {
  console.error("Usage: npx ts-node src/scripts/deleteUser.ts <email>");
  process.exit(1);
}

deleteUserByEmail(email).catch((err) => {
  console.error("Error:", err);
  mongoose.disconnect();
  process.exit(1);
});
