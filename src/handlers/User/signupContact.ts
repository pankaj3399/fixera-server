import { Request, Response } from "express";
import twilio from "twilio";
import { PhoneNumberUtil, PhoneNumberFormat } from "google-libphonenumber";
import User from "../../models/user";
import connecToDatabase from "../../config/db";
import { generateOTP, sendOTPEmail } from "../../utils/emailService";
import { sendHandlerError } from "../../utils/handlerErrors";
import { withAnonymizationWriteFence } from "../../utils/support/accountGuard";
import {
  SIGNUP_CUSTOMER_TYPES,
  SIGNUP_EMAIL_RE,
  buildSignupLocation,
  hashSignupPassword,
  resolveBusinessCustomerFields,
  signupPasswordError,
} from "../../utils/signupValidation";

const phoneUtil = PhoneNumberUtil.getInstance();
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
/** Minimum wait between two email changes, so the endpoint can't be used to mail arbitrary addresses in a loop. */
export const SIGNUP_EMAIL_CHANGE_COOLDOWN_MS = 60 * 1000;

const SIGNUP_CONTACT_ROLES = new Set(["customer", "professional"]);

/** E.164 for a "+<country><number>" signup phone, or null when invalid. */
export function normalizeSignupPhone(raw: string): string | null {
  const phone = raw.trim();
  if (!phone.startsWith("+")) return null;
  try {
    const parsed = phoneUtil.parseAndKeepRawInput(phone, "");
    if (!phoneUtil.isValidNumber(parsed)) return null;
    return phoneUtil.format(parsed, PhoneNumberFormat.E164);
  } catch {
    return null;
  }
}

/** Fields of the signup form this step can change. */
const SIGNUP_FIELDS = [
  "name", "email", "phone", "password", "customerType",
  "address", "city", "country", "postalCode", "latitude", "longitude",
  "companyName", "vatNumber", "marketingOptIn",
] as const;
const CUSTOMER_FIELDS = ["customerType", "address", "city", "country", "postalCode", "companyName", "vatNumber"] as const;
const LOCATION_FIELDS = ["address", "city", "country", "postalCode"] as const;

/** Stored fields the signup form shows (projection for reads and the write). */
const SIGNUP_DETAILS_PROJECTION =
  "role name email phone isEmailVerified isPhoneVerified customerType businessInfo businessName vatNumber isVatVerified location marketingOptInPending notificationPreferences";

type StoredSignupUser = {
  role?: string;
  name?: string;
  email?: string;
  phone?: string;
  isEmailVerified?: boolean;
  isPhoneVerified?: boolean;
  customerType?: string;
  businessInfo?: { companyName?: string } | null;
  businessName?: string;
  vatNumber?: string;
  isVatVerified?: boolean;
  location?: { address?: string; city?: string; country?: string; postalCode?: string; coordinates?: number[] } | null;
  marketingOptInPending?: boolean;
  notificationPreferences?: { promotions?: { email?: boolean } } | null;
};

/**
 * The signup form's values for a stored account (FT2-6C prefill). The
 * marketing opt-in is the pending signup opt-in until the email is verified;
 * after that it was acted upon and belongs to the notification settings.
 */
export function signupDetailsOf(user: StoredSignupUser) {
  const location = user.location?.address
    ? {
      address: user.location.address ?? "",
      city: user.location.city ?? "",
      country: user.location.country ?? "",
      postalCode: user.location.postalCode ?? "",
      latitude: user.location.coordinates?.length === 2 ? user.location.coordinates[1] : null,
      longitude: user.location.coordinates?.length === 2 ? user.location.coordinates[0] : null,
    }
    : null;
  const isCustomer = user.role === "customer";
  return {
    role: user.role,
    name: user.name ?? "",
    email: user.email ?? "",
    phone: user.phone ?? "",
    isEmailVerified: Boolean(user.isEmailVerified),
    isPhoneVerified: Boolean(user.isPhoneVerified),
    customerType: isCustomer ? (user.customerType === "business" ? "business" : "individual") : null,
    companyName: isCustomer ? (user.businessInfo?.companyName ?? user.businessName ?? "") : "",
    vatNumber: isCustomer ? (user.vatNumber ?? "") : "",
    isVatVerified: Boolean(user.isVatVerified),
    location: isCustomer ? location : null,
    marketingOptIn: user.isEmailVerified
      ? Boolean(user.notificationPreferences?.promotions?.email)
      : Boolean(user.marketingOptInPending),
    marketingOptInEditable: !user.isEmailVerified,
  };
}

/**
 * Shared gate: signed in, customer/professional, and not fully verified yet.
 * Returns the loaded user, or sends the refusal and returns null.
 */
async function loadSignupUser(req: Request, res: Response, select?: string) {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, msg: "Authentication required" });
    return null;
  }
  await connecToDatabase();
  const query = User.findById(userId);
  const user = await (select ? query.select(select) : query);
  if (!user) {
    res.status(404).json({ success: false, msg: "User not found" });
    return null;
  }
  if (!SIGNUP_CONTACT_ROLES.has(user.role)) {
    res.status(403).json({ success: false, msg: "Your details can only be changed here during signup" });
    return null;
  }
  if (user.isEmailVerified && user.isPhoneVerified) {
    res.status(409).json({ success: false, msg: "Your account is already verified. Change your details in your profile." });
    return null;
  }
  return user;
}

/**
 * FT2-6C: prefill for the "back" step. Returns the signup form's values of the
 * signed-in, not yet verified account, so the form shows what is stored on the
 * server rather than what the browser happens to remember.
 */
export const getSignupContact = async (req: Request, res: Response) => {
  try {
    const user = await loadSignupUser(req, res);
    if (!user) return;
    return res.status(200).json({ success: true, data: signupDetailsOf(user) });
  } catch (error) {
    console.error("Get signup details error:", error);
    return sendHandlerError(res, error, "We couldn't load your details. Please try again.");
  }
};

const has = (body: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

/**
 * FT2-6C: the "back" step of signup verification. The account already exists
 * when the email/phone OTP page shows (signup creates it and signs the user
 * in), so resubmitting the signup form failed with "email already exists" or
 * left a second account behind. This lets the signed-in, not yet verified
 * user correct everything the signup form collected on THEIR OWN account,
 * with the signup handler's validation. A changed email or phone becomes
 * unverified again and gets a fresh code; an unchanged one keeps its code. A
 * channel that is already verified cannot be changed here (profile settings
 * own that). The password is optional: blank keeps the current one.
 */
export const updateSignupContact = async (req: Request, res: Response) => {
  try {
    const body: Record<string, unknown> =
      req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    if (!req.user?.id) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }
    if (!SIGNUP_FIELDS.some((field) => has(body, field))) {
      return res.status(400).json({ success: false, msg: "Please provide the details you want to update" });
    }

    // verificationCodeExpires is select:false on the schema; the cooldown and the
    // conditional write below both need the stored value.
    const user = await loadSignupUser(req, res, "+verificationCodeExpires +signupEmailChangedAt");
    if (!user) return;

    let emailChanged = false;
    let phoneChanged = false;
    let passwordChanged = false;
    let emailOtp: string | null = null;
    // The write is conditional on what was read: a channel verified (or
    // changed) by a concurrent request since then makes it miss instead of
    // carrying a stale verification flag over to the new address, or editing
    // an account that meanwhile left the signup step.
    const filter: Record<string, unknown> = {
      _id: user._id,
      isEmailVerified: Boolean(user.isEmailVerified),
      isPhoneVerified: Boolean(user.isPhoneVerified),
    };
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};

    if (has(body, "name")) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return res.status(400).json({ success: false, msg: "Please provide your full name" });
      }
      set.name = name;
    }

    if (has(body, "email")) {
      const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
      if (!SIGNUP_EMAIL_RE.test(email)) {
        return res.status(400).json({ success: false, msg: "Please provide a valid email address" });
      }
      if (email !== user.email) {
        if (user.isEmailVerified) {
          return res.status(409).json({ success: false, msg: "Your email address is already verified. Change it in your profile." });
        }
        // The cooldown is between two edits from this step: correcting a typo
        // right after signup (whose code was just sent) must work at once.
        const lastChangedAt = user.signupEmailChangedAt ? new Date(user.signupEmailChangedAt).getTime() : 0;
        if (Date.now() - lastChangedAt < SIGNUP_EMAIL_CHANGE_COOLDOWN_MS) {
          return res.status(429).json({ success: false, msg: "Please wait a minute before changing your email address again" });
        }
        const taken = await User.findOne({ email, _id: { $ne: user._id } }).select("_id").lean();
        if (taken) {
          return res.status(409).json({ success: false, msg: "An account with this email already exists" });
        }
        emailOtp = generateOTP();
        filter.email = user.email;
        filter.isEmailVerified = false;
        filter.verificationCodeExpires = user.verificationCodeExpires ?? null;
        filter.signupEmailChangedAt = user.signupEmailChangedAt ?? null;
        set.email = email;
        set.isEmailVerified = false;
        set.verificationCode = emailOtp;
        set.verificationCodeExpires = new Date(Date.now() + EMAIL_OTP_TTL_MS);
        set.signupEmailChangedAt = new Date();
        emailChanged = true;
      }
    }

    if (has(body, "phone")) {
      const phone = typeof body.phone === "string" ? normalizeSignupPhone(body.phone) : null;
      if (!phone) {
        return res.status(400).json({ success: false, msg: "Invalid phone number. Please include your country code (e.g. +1 for US, +31 for NL)." });
      }
      if (phone !== user.phone) {
        if (user.isPhoneVerified) {
          return res.status(409).json({ success: false, msg: "Your phone number is already verified. Change it in your profile." });
        }
        filter.phone = user.phone ?? null;
        filter.isPhoneVerified = false;
        set.phone = phone;
        set.isPhoneVerified = false;
        phoneChanged = true;
      }
    }

    // Optional here: blank keeps the current password; a new one meets the
    // signup strength rules and is hashed the way signup hashes it.
    if (has(body, "password") && body.password !== "") {
      if (typeof body.password !== "string") {
        return res.status(400).json({ success: false, msg: "Password must be at least 6 characters long" });
      }
      const passwordError = signupPasswordError(body.password);
      if (passwordError) {
        return res.status(400).json({ success: false, msg: passwordError });
      }
      set.password = await hashSignupPassword(body.password);
      passwordChanged = true;
    }

    // Customer-only fields, as on the customer signup form. A professional's
    // signup form has none of them, so they are ignored like signup does.
    if (user.role === "customer" && CUSTOMER_FIELDS.some((field) => has(body, field))) {
      let customerType: string = user.customerType === "business" ? "business" : "individual";
      if (has(body, "customerType")) {
        if (!(SIGNUP_CUSTOMER_TYPES as readonly unknown[]).includes(body.customerType)) {
          return res.status(400).json({ success: false, msg: "Please choose an individual or business account" });
        }
        customerType = body.customerType as string;
        set.customerType = customerType;
      }

      if (LOCATION_FIELDS.some((field) => has(body, field))) {
        const location = buildSignupLocation(body);
        if (!location) {
          return res.status(400).json({ success: false, msg: "Please provide your full address: street, city, postal code and country" });
        }
        set.location = location;
      }

      if (customerType === "business") {
        const business = await resolveBusinessCustomerFields(
          has(body, "companyName") ? body.companyName : (user.businessInfo?.companyName ?? user.businessName),
          has(body, "vatNumber") ? body.vatNumber : user.vatNumber,
          { vatNumber: user.vatNumber, isVatVerified: user.isVatVerified },
        );
        if (!business.ok) {
          return res.status(400).json({ success: false, msg: business.msg });
        }
        set["businessInfo.companyName"] = business.companyName;
        set.vatNumber = business.vatNumber;
        set.isVatVerified = business.isVatVerified;
      } else if (user.customerType === "business" || user.vatNumber || user.businessInfo?.companyName) {
        // Switched to an individual account: drop what only a business has,
        // like an individual signup never stores it.
        unset.vatNumber = 1;
        unset["businessInfo.companyName"] = 1;
        unset.businessName = 1;
        set.isVatVerified = false;
      }
    }

    // The signup opt-in stays pending until the email is verified (see
    // verifyEmailOTP). Once verified it was acted upon; changes then go
    // through the notification settings, so it is left alone here.
    if (has(body, "marketingOptIn") && typeof body.marketingOptIn === "boolean" && !user.isEmailVerified) {
      set.marketingOptInPending = body.marketingOptIn;
    }

    let current: StoredSignupUser = user.toObject ? user.toObject() : (user as StoredSignupUser);
    if (Object.keys(set).length > 0 || Object.keys(unset).length > 0) {
      const update: Record<string, unknown> = { $set: set };
      if (Object.keys(unset).length > 0) update.$unset = unset;
      const updated = await withAnonymizationWriteFence([String(user._id)], async (session) =>
        User.findOneAndUpdate(filter, update, {
          new: true,
          runValidators: true,
          projection: SIGNUP_DETAILS_PROJECTION,
          ...(session ? { session } : {}),
        }).lean(),
      );
      if (!updated) {
        return res.status(409).json({ success: false, msg: "Your details changed meanwhile. Please reload and try again." });
      }
      current = updated as StoredSignupUser;
    }

    let emailOtpSent = false;
    if (emailChanged && emailOtp) {
      try {
        emailOtpSent = await sendOTPEmail(current.email as string, emailOtp, current.name ?? user.name);
      } catch (error) {
        console.error("Error sending email OTP after signup contact change:", error);
      }
    }

    let phoneOtpSent = false;
    if (phoneChanged) {
      try {
        const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env;
        if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID) {
          await twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
            .verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
            .verifications.create({ channel: "sms", to: current.phone as string });
          phoneOtpSent = true;
        }
      } catch (error) {
        console.error("Error sending phone OTP after signup contact change:", error);
      }
    }

    return res.status(200).json({
      success: true,
      msg: "Your details were updated",
      data: {
        ...signupDetailsOf(current),
        emailChanged,
        phoneChanged,
        passwordChanged,
        emailOtpSent,
        phoneOtpSent,
      },
    });
  } catch (error) {
    console.error("Update signup contact error:", error);
    return sendHandlerError(res, error, "We couldn't update your details. Please try again.");
  }
};
