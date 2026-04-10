import mongoose from "mongoose";
import User from "../models/user";
import Booking from "../models/booking";
import Conversation from "../models/conversation";
import ChatMessage from "../models/chatMessage";
import Project from "../models/project";
import Referral from "../models/referral";
import PointTransaction from "../models/pointTransaction";
import Meeting from "../models/meeting";
import WarrantyClaim from "../models/warrantyClaim";
import ChatReport from "../models/chatReport";
import { deleteFromS3, parseS3KeyFromUrl, isAllowedS3Url } from "./s3Upload";

async function deleteS3Files(urls: (string | undefined | null)[]) {
  for (const url of urls) {
    if (!url) continue;
    if (!isAllowedS3Url(url)) continue;
    const key = parseS3KeyFromUrl(url);
    if (!key) continue;
    try {
      await deleteFromS3(key);
    } catch (err) {
      console.error(`Failed to delete S3 file: ${key}`, err);
    }
  }
}

async function collectBookingS3Urls(bookings: any[]): Promise<string[]> {
  const urls: string[] = [];
  for (const b of bookings) {
    if (b.rfq?.attachments) urls.push(...b.rfq.attachments);
    if (b.completionDetails?.images) urls.push(...b.completionDetails.images);
    if (b.completionDetails?.attachments) urls.push(...b.completionDetails.attachments);
    if (b.extraCosts) {
      for (const cost of b.extraCosts) {
        if (cost.attachments) urls.push(...cost.attachments);
      }
    }
  }
  return urls;
}

async function collectChatS3Urls(conversationIds: mongoose.Types.ObjectId[]): Promise<string[]> {
  const urls: string[] = [];
  const messages = await ChatMessage.find({ conversationId: { $in: conversationIds } }).lean();
  for (const msg of messages) {
    if ((msg as any).images) urls.push(...(msg as any).images);
    if ((msg as any).attachments) {
      for (const att of (msg as any).attachments) {
        if (att.url) urls.push(att.url);
      }
    }
  }
  return urls;
}

async function collectProjectS3Urls(projects: any[]): Promise<string[]> {
  const urls: string[] = [];
  for (const p of projects) {
    if (p.professionalAttachments) urls.push(...p.professionalAttachments);
    if (p.questions) {
      for (const q of p.questions) {
        if (q.professionalAttachments) urls.push(...q.professionalAttachments);
      }
    }
  }
  return urls;
}

async function collectWarrantyS3Urls(claims: any[]): Promise<string[]> {
  const urls: string[] = [];
  for (const c of claims) {
    if (c.evidence) urls.push(...c.evidence);
    if (c.resolution?.attachments) urls.push(...c.resolution.attachments);
  }
  return urls;
}

export async function deleteUserData(userId: mongoose.Types.ObjectId) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  const bookings = await Booking.find({ $or: [{ customer: userId }, { professional: userId }] }).lean();

  const conversations = await Conversation.find({
    $or: [{ customerId: userId }, { professionalId: userId }],
  }).lean();
  const conversationIds = conversations.map((c) => c._id);

  const projects = await Project.find({ professionalId: userId }).lean();

  const warrantyClaims = await WarrantyClaim.find({
    $or: [{ customer: userId }, { professional: userId }],
  }).lean();

  await deleteS3Files([user.profileImage]);
  await deleteS3Files(await collectBookingS3Urls(bookings));
  await deleteS3Files(await collectChatS3Urls(conversationIds as mongoose.Types.ObjectId[]));
  await deleteS3Files(await collectProjectS3Urls(projects));
  await deleteS3Files(await collectWarrantyS3Urls(warrantyClaims));

  await ChatMessage.deleteMany({ conversationId: { $in: conversationIds } });
  await Conversation.deleteMany({ $or: [{ customerId: userId }, { professionalId: userId }] });
  await Booking.deleteMany({ $or: [{ customer: userId }, { professional: userId }] });
  await mongoose.connection.collection("payments").deleteMany({ $or: [{ customer: userId }, { professional: userId }] });
  await Project.deleteMany({ professionalId: userId });
  await Referral.deleteMany({ $or: [{ referrer: userId }, { referredUser: userId }] });
  await PointTransaction.deleteMany({ userId });
  await Meeting.deleteMany({ $or: [{ professionalId: userId }, { "attendees.userId": userId.toString() }, { createdBy: userId.toString() }] });
  await WarrantyClaim.deleteMany({ $or: [{ customer: userId }, { professional: userId }] });
  await ChatReport.deleteMany({ reportedBy: userId });
  await User.deleteOne({ _id: userId });
}
