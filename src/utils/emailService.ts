import { TransactionalEmailsApi, SendSmtpEmail, TransactionalEmailsApiApiKeys } from "@getbrevo/brevo";

// Initialize Brevo API with proper configuration
const createEmailAPI = () => {
  const api = new TransactionalEmailsApi();
  
  // Set API key using the correct method
  if (process.env.BREVO_API_KEY) {
    api.setApiKey(TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
  } else {
    console.error("BREVO_API_KEY environment variable is not set");
  }
  
  return api;
};

// Generate a 6-digit OTP
export const generateOTP = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const escapeHtml = (value: string | undefined | null): string => {
  const input = String(value ?? "");
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
};

// Common email header template
const getEmailHeader = (title: string) => `
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Fixera</h1>
    <p style="color: white; margin: 10px 0 0 0; font-size: 16px;">${escapeHtml(title)}</p>
  </div>
`;

// Common email footer template
const getEmailFooter = () => `
  <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
    <p style="color: #999; font-size: 12px; margin: 0;">
      © 2025 Fixera. All rights reserved.
    </p>
  </div>
`;

// Send OTP email using Brevo
export const sendOTPEmail = async (email: string, otp: string, userName: string): Promise<boolean> => {
  try {
    const safeUserName = escapeHtml(userName);
    const safeOtp = escapeHtml(otp);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Email Verification")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeUserName}!</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for joining Fixera! To complete your registration, please use the verification code below:
          </p>
          
          <div style="background: #fff; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 10px 0; font-size: 18px;">Your Verification Code</h3>
            <div style="font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 8px; font-family: 'Courier New', monospace;">
              ${safeOtp}
            </div>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            This code will expire in 10 minutes for security reasons.
          </p>
          
          <div style="background: #e8f4fd; border-left: 4px solid #667eea; padding: 15px; margin: 25px 0;">
            <p style="color: #333; margin: 0; font-size: 14px;">
              <strong>Security Tip:</strong> Never share this code with anyone. Fixera will never ask for this code via phone or email.
            </p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            If you didn't create an account with Fixera, please ignore this email.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;
    const emailAPI = createEmailAPI(); 
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Verify Your Fixera Account";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixera Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    return false;
  }
};

// Send welcome email after signup
export const sendWelcomeEmail = async (email: string, userName: string): Promise<boolean> => {
  try {
    const safeUserName = escapeHtml(userName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Welcome to Fixera!")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Welcome ${safeUserName}!</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for joining Fixera! Your account has been successfully created. We're excited to have you as part of our community of homeowners and skilled professionals.
          </p>
          
          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">✨ Next Steps</h3>
            <p style="color: #333; margin: 0 0 15px 0; line-height: 1.6;">
              Complete your profile to get the most out of Fixera and start connecting with our verified professionals.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/profile" 
                 style="background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Complete Your Profile
              </a>
            </div>
          </div>
          
          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">🏠 What you can do with Fixera:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Find verified professionals for home services</li>
              <li>Get instant quotes or custom project estimates</li>
              <li>Book services with secure payment protection</li>
              <li>Enjoy up to 10-year warranty on completed work</li>
            </ul>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Questions? Our support team is here to help 24/7. Reply to this email or contact us anytime.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Welcome to Fixera - Let's Complete Your Profile!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixera Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

   await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

export const sendProfessionalWelcomeEmail = async (email: string, professionalName: string): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Welcome to Fixera Professionals")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Welcome ${safeProfessionalName}!</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Your professional onboarding has been submitted successfully. You can now access your dashboard and profile while our team reviews your account.
          </p>

          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">Next Steps</h3>
            <p style="color: #333; margin: 0 0 15px 0; line-height: 1.6;">
              Review your business profile, keep your availability updated, and watch for approval from the Fixera team.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard"
                 style="background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
                Open Dashboard
              </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/profile"
                 style="background: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Open Profile
              </a>
            </div>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Once approved, you will be able to create projects and start working with customers on Fixera.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Welcome to Fixera Professionals";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send professional welcome email:', error);
    return false;
  }
};

// Send ID expired email to professionals
export const sendIdExpiredEmail = async (email: string, userName: string): Promise<boolean> => {
  try {
    const safeUserName = escapeHtml(userName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Action Required: ID Expired")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeUserName},</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Our records show that your ID document has expired. To keep your professional profile active, please upload a valid ID and update your expiration date.
          </p>
          
          <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #856404; margin: 0 0 15px 0; font-size: 18px;">Required Action</h3>
            <p style="color: #333; margin: 0; line-height: 1.6;">
              Upload a valid ID document and provide the updated expiration date.
            </p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professional/onboarding"
               style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Update ID Now
            </a>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            If you have questions, reply to this email and our support team will help.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixera: Your ID Has Expired";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional approval email
export const sendProfessionalApprovalEmail = async (email: string, professionalName: string): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Profile Approved! 🎉")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Congratulations ${safeProfessionalName}!</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Great news! Your professional profile has been approved by our team. You can now start accepting projects and connecting with customers on Fixera.
          </p>
          
          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">🚀 You're All Set!</h3>
            <p style="color: #333; margin: 0 0 20px 0; line-height: 1.6;">
              Your profile is now live and customers can find you. Start by creating your first project listing or update your availability.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard" 
                 style="background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
                Go to Dashboard
              </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/projects/create" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Create Project
              </a>
            </div>
          </div>
          
          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">💼 What's next:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Update your availability calendar</li>
              <li>Add portfolio images and certifications</li>
              <li>Set your hourly rates and service areas</li>
              <li>Start receiving project inquiries from customers</li>
            </ul>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Welcome to the Fixera professional community! We're here to support your success.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "🎉 Your Fixera Professional Profile is Approved!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixera Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {

    return false;
  }
};

// Send professional rejection email
export const sendProfessionalRejectionEmail = async (email: string, professionalName: string, reason: string): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);
    const safeReason = escapeHtml(reason);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Profile Update Required")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for your interest in becoming a verified professional on Fixera. After reviewing your profile, we need you to address some items before we can approve your account.
          </p>
          
          <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #856404; margin: 0 0 15px 0; font-size: 18px;">⚠️ Items to Address</h3>
            <div style="background: #fff; border-left: 4px solid #ffc107; padding: 15px; border-radius: 4px;">
              <p style="color: #333; margin: 0; line-height: 1.6;">
                <strong>Reason:</strong> ${safeReason}
              </p>
            </div>
          </div>
          
          <div style="background: #e8f4fd; border: 2px solid #667eea; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 How to Fix This</h3>
            <p style="color: #333; margin: 0 0 15px 0; line-height: 1.6;">
              Please update your profile with the requested information, then click "Send for Verification" to resubmit for review.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/profile" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Update Profile
              </a>
            </div>
          </div>
          
          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">📋 Common Requirements:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Valid government-issued ID (passport, driver's license)</li>
              <li>EU VAT number validation (for EU professionals)</li>
              <li>Complete business information and contact details</li>
              <li>Professional certifications or proof of expertise</li>
            </ul>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Once you've made the necessary updates, we'll review your profile again within 48 hours. If you have questions, feel free to reply to this email.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixera Profile Update Required - Please Review";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixera Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional ID change rejection email (account remains approved)
export const sendProfessionalIdChangeRejectionEmail = async (
  email: string,
  professionalName: string,
  reason: string
): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);
    const safeReason = escapeHtml(reason);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("ID Document Update Rejected")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Your recent ID document update was reviewed and could not be approved at this time.
            <strong>Your professional account remains approved and active.</strong>
          </p>

          <div style="background: #fff3cd; border: 1px solid #ffeeba; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;"><strong>Reason:</strong> ${safeReason}</p>
          </div>

          <p style="color: #666; line-height: 1.6;">
            Please upload an updated document that addresses the issue above. If you have questions, reply to this email and our team will help.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "ID document rejected — account remains approved";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixera Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional ID change approval email (account was already approved, ID update accepted)
export const sendProfessionalIdChangeApprovalEmail = async (
  email: string,
  professionalName: string
): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("ID Document Update Approved")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Your recent ID document update has been reviewed and approved by our team.
            <strong>Your professional account remains approved and active.</strong>
          </p>

          <div style="background: #e8f5e8; border: 1px solid #4CAF50; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0; color: #2E7D32;"><strong>Your updated ID information is now on file.</strong></p>
          </div>

          <p style="color: #666; line-height: 1.6;">
            No further action is needed. If you have any questions, reply to this email and our team will help.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "ID document update approved — account remains approved";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional suspension email
export const sendProfessionalSuspensionEmail = async (email: string, name: string, reason: string): Promise<boolean> => {
  try {
    console.log(`📧 Sending suspension email to ${email}`);
    const safeName = escapeHtml(name);
    const safeReason = escapeHtml(reason);

    const emailContent = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8fafc; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          
          ${getEmailHeader("Account Suspension")}
          
          <div style="text-align: center; margin-bottom: 30px;">
            <div style="background: #fee2e2; border: 2px solid #ef4444; border-radius: 50%; width: 80px; height: 80px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
              <span style="font-size: 36px;">⏸️</span>
            </div>
            <h2 style="color: #dc2626; margin: 0; font-size: 24px; font-weight: bold;">Account Suspended</h2>
          </div>
          
          <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
            Dear <strong>${safeName}</strong>,
          </p>
          
          <p style="color: #333; line-height: 1.6; margin-bottom: 20px;">
            We're writing to inform you that your Fixera professional account has been temporarily suspended.
          </p>
          
          <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #92400e; margin: 0 0 15px 0; font-size: 18px;">📋 Reason for Suspension</h3>
            <p style="color: #333; margin: 0; line-height: 1.6; font-style: italic;">
              "${safeReason}"
            </p>
          </div>
          
          <div style="background: #e8f4fd; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 What This Means</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>Your account access has been temporarily disabled</li>
              <li>You cannot receive new appointments during suspension</li>
              <li>Existing appointments may be affected</li>
              <li>You can appeal this decision by contacting support</li>
            </ul>
          </div>
          
          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">📞 Need Help?</h3>
            <p style="color: #666; line-height: 1.6; margin: 0;">
              If you believe this suspension was made in error or if you'd like to discuss this decision, please contact our support team immediately. We're here to help resolve any issues.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="mailto:support@fixera.com" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Contact Support
              </a>
            </div>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            We take these matters seriously and appreciate your understanding. Our team is available to assist you through this process.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixera Account Suspended - Action Required";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixera Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional unsuspension/reactivation email
export const sendProfessionalReactivationEmail = async (email: string, name: string): Promise<boolean> => {
  try {
    console.log(`📧 Sending reactivation email to ${email}`);
    const safeName = escapeHtml(name);

    const emailContent = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8fafc; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          
          ${getEmailHeader("Account Reactivated")}
          
          <div style="text-align: center; margin-bottom: 30px;">
            <div style="background: #dcfce7; border: 2px solid #16a34a; border-radius: 50%; width: 80px; height: 80px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
              <span style="font-size: 36px;">✅</span>
            </div>
            <h2 style="color: #16a34a; margin: 0; font-size: 24px; font-weight: bold;">Account Reactivated!</h2>
          </div>
          
          <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
            Dear <strong>${safeName}</strong>,
          </p>
          
          <p style="color: #333; line-height: 1.6; margin-bottom: 20px;">
            Great news! Your Fixera professional account has been reactivated and is now fully operational.
          </p>
          
          <div style="background: #dcfce7; border: 2px solid #16a34a; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #15803d; margin: 0 0 15px 0; font-size: 18px;">🎉 You Can Now</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>Access your professional dashboard</li>
              <li>Receive new appointment requests</li>
              <li>Manage your schedule and availability</li>
              <li>Update your professional profile</li>
            </ul>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard" 
               style="background: #667eea; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 16px;">
              Access Your Dashboard
            </a>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Thank you for your patience during this process. We're excited to have you back on the platform and look forward to your continued success with Fixera.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixera Account Reactivated - Welcome Back!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixera Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send team member invitation email
export const sendTeamMemberInvitationEmail = async (
  email: string,
  teamMemberName: string,
  companyName: string,
  loginEmail: string,
  temporaryPassword: string
): Promise<boolean> => {
  try {
    const emailAPI = createEmailAPI();
    const safeTeamMemberName = escapeHtml(teamMemberName);
    const safeCompanyName = escapeHtml(companyName);
    const safeLoginEmail = escapeHtml(loginEmail);
    const safeTemporaryPassword = escapeHtml(temporaryPassword);

    const htmlContent = `
      <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif; background: #f9f9f9; padding: 20px;">
        <div style="background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          ${getEmailHeader('Team Member Invitation')}

          <div style="padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px;">Welcome to the Team, ${safeTeamMemberName}!</h2>

            <p style="color: #666; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
              You have been invited to join <strong>${safeCompanyName}</strong> as a team member on the Fixera platform.
            </p>

            <div style="background: #f8f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea;">
              <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">Your Login Credentials</h3>
              <p style="margin: 5px 0; color: #666;"><strong>Email:</strong> ${safeLoginEmail}</p>
              <p style="margin: 5px 0; color: #666;"><strong>Temporary Password:</strong> <code style="background: #e8e8e8; padding: 4px 8px; border-radius: 4px; font-family: monospace;">${safeTemporaryPassword}</code></p>
            </div>

            <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
              <p style="margin: 0; color: #856404; font-size: 14px;">
                <strong>Security Note:</strong> Please change your password after your first login for security purposes.
              </p>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/login"
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: bold; display: inline-block;">
                Login to Your Account
              </a>
            </div>

            <div style="margin-top: 30px;">
              <h3 style="color: #333; margin-bottom: 15px; font-size: 18px;">What's Next?</h3>
              <ul style="color: #666; line-height: 1.8; padding-left: 20px;">
                <li>Log in using your provided credentials</li>
                <li>Change your password for security</li>
                <li>Set up your availability preferences</li>
                <li>Start collaborating with your team</li>
              </ul>
            </div>

            <p style="color: #999; font-size: 14px; margin-top: 30px;">
              If you have any questions or need assistance, please contact your company administrator or reach out to our support team.
            </p>
          </div>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const sendSmtpEmail: SendSmtpEmail = {
      to: [{ email: email, name: teamMemberName }],
      subject: `Welcome to ${companyName} - Team Member Invitation`,
      htmlContent: htmlContent,
      sender: {
        email: process.env.FROM_EMAIL || 'noreply@fixera.com',
        name: 'Fixera Team'
      },
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    return false;
  }
};

// Send project approval email
export const sendProjectApprovalEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  projectId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project approval email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const encodedProjectId = encodeURIComponent(projectId);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Approved! 🎉")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Congratulations ${safeProfessionalName}!</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Great news! Your project "<strong>${safeProjectTitle}</strong>" has been approved and is now live on Fixera.
          </p>

          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">🚀 Your Project is Live!</h3>
            <p style="color: #333; margin: 0 0 20px 0; line-height: 1.6;">
              Customers can now find and book your project. Start managing your bookings and connecting with clients.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professioanl/projects/${encodedProjectId}"
                  style="background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
                 View Project
               </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard"
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Go to Dashboard
              </a>
            </div>
          </div>

          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">💼 Next Steps:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Monitor inquiries and booking requests</li>
              <li>Keep your availability calendar updated</li>
              <li>Respond promptly to customer messages</li>
              <li>Deliver quality service to earn great reviews</li>
            </ul>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Thank you for being part of the Fixera community. We're excited to see your project succeed!
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "🎉 Your Fixera Project is Approved!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project approval email:', error);
    return false;
  }
};

// Send project rejection email
export const sendProjectRejectionEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  feedback: string,
  projectId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project rejection email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const safeFeedback = escapeHtml(feedback);
    const encodedProjectId = encodeURIComponent(projectId);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Update Required")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for submitting your project "<strong>${safeProjectTitle}</strong>". After reviewing it, we need you to address some items before we can approve it.
          </p>

          <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #856404; margin: 0 0 15px 0; font-size: 18px;">⚠️ Items to Address</h3>
            <div style="background: #fff; border-left: 4px solid #ffc107; padding: 15px; border-radius: 4px;">
              <p style="color: #333; margin: 0; line-height: 1.6;">
                <strong>Feedback:</strong> ${safeFeedback}
              </p>
            </div>
          </div>

          <div style="background: #e8f4fd; border: 2px solid #667eea; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 How to Fix This</h3>
            <p style="color: #333; margin: 0 0 15px 0; line-height: 1.6;">
              Please update your project with the requested changes, then resubmit it for review.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professional/projects/${encodedProjectId}/edit"
                  style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                 Edit Project
               </a>
            </div>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Once you've made the necessary updates, we'll review your project again within 48 hours. If you have questions, feel free to reply to this email.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixera Project Update Required - Please Review";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project rejection email:', error);
    return false;
  }
};

// Send project deleted email
export const sendProjectDeletedEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  reason: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project deletion email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const safeReason = escapeHtml(reason);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Deleted")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            We're writing to inform you that your project "<strong>${safeProjectTitle}</strong>" has been removed from Fixera.
          </p>

          <div style="background: #fee2e2; border: 2px solid #ef4444; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #dc2626; margin: 0 0 15px 0; font-size: 18px;">❌ Reason for Deletion</h3>
            <div style="background: #fff; border-left: 4px solid #ef4444; padding: 15px; border-radius: 4px;">
              <p style="color: #333; margin: 0; line-height: 1.6;">
                ${safeReason}
              </p>
            </div>
          </div>

          <div style="background: #e8f4fd; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 What This Means</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>The project is no longer visible on the platform</li>
              <li>You can create a new project that complies with our guidelines</li>
              <li>Contact support if you have questions about this decision</li>
            </ul>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/projects/create"
               style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
              Create New Project
            </a>
            <a href="mailto:support@fixera.com"
               style="background: #6b7280; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Contact Support
            </a>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            We appreciate your understanding and look forward to seeing your future projects on Fixera.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixera Project Deleted - Important Notice";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project deletion email:', error);
    return false;
  }
};

// Send project deactivated email
export const sendProjectDeactivatedEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  reason: string,
  projectId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project deactivation email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const safeReason = escapeHtml(reason);
    const encodedProjectId = encodeURIComponent(projectId);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Temporarily Deactivated")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            We're writing to inform you that your project "<strong>${safeProjectTitle}</strong>" has been temporarily deactivated.
          </p>

          <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #92400e; margin: 0 0 15px 0; font-size: 18px;">⏸️ Reason for Deactivation</h3>
            <div style="background: #fff; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px;">
              <p style="color: #333; margin: 0; line-height: 1.6;">
                ${safeReason}
              </p>
            </div>
          </div>

          <div style="background: #e8f4fd; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 What This Means</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>The project is temporarily hidden from customers</li>
              <li>You can still access and edit the project</li>
              <li>New bookings are paused until reactivation</li>
              <li>Contact support to resolve this issue and reactivate</li>
            </ul>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professional/projects/${encodedProjectId}/edit"
               style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
              View Project
            </a>
            <a href="mailto:support@fixera.com"
               style="background: #6b7280; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Contact Support
            </a>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Once the issue is resolved, your project will be reactivated and visible to customers again.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixera Project Temporarily Deactivated";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project deactivation email:', error);
    return false;
  }
};

// Send project reactivated email
export const sendProjectReactivatedEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  projectId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project reactivation email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const encodedProjectId = encodeURIComponent(projectId);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Reactivated! ✅")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Great News, ${safeProfessionalName}!</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Your project "<strong>${safeProjectTitle}</strong>" has been reactivated and is now live on Fixera again!
          </p>

          <div style="background: #dcfce7; border: 2px solid #16a34a; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #15803d; margin: 0 0 15px 0; font-size: 18px;">🎉 Your Project is Live!</h3>
            <p style="color: #333; margin: 0 0 20px 0; line-height: 1.6;">
              Customers can now find and book your project again. Continue managing your bookings and connecting with clients.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professional/projects/${encodedProjectId}"
                  style="background: #16a34a; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
                 View Project
               </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard"
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Go to Dashboard
              </a>
            </div>
          </div>

          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">💼 Keep It Going:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Monitor new inquiries and booking requests</li>
              <li>Keep your availability calendar updated</li>
              <li>Respond promptly to customer messages</li>
              <li>Maintain high service quality standards</li>
            </ul>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Thank you for your patience. We're excited to have your project back on the platform!
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "🎉 Your Fixera Project is Reactivated!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project reactivation email:', error);
    return false;
  }
};

// Send booking request notification to professional
export const sendBookingNotificationEmail = async (
  professionalEmail: string,
  professionalName: string,
  customerName: string,
  projectTitle: string,
  preferredDate: string,
  bookingId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending booking notification email to ${professionalEmail}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeCustomerName = escapeHtml(customerName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const safePreferredDate = escapeHtml(preferredDate);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("New Booking Request! 🎉")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Congratulations ${safeProfessionalName}!</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            You've received a new booking request for your project "<strong>${safeProjectTitle}</strong>"!
          </p>

          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">📋 Booking Details</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.8;">
              <li><strong>Customer:</strong> ${safeCustomerName}</li>
              <li><strong>Project:</strong> ${safeProjectTitle}</li>
              <li><strong>Preferred Start Date:</strong> ${safePreferredDate}</li>
              <li><strong>Status:</strong> Awaiting Your Quote</li>
            </ul>
          </div>

          <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 20px; margin: 25px 0;">
            <h3 style="color: #856404; margin: 0 0 15px 0; font-size: 18px;">⏰ What's Next?</h3>
            <p style="color: #333; margin: 0; line-height: 1.6;">
              Review the booking details and customer requirements, then provide your quote. We'll notify you when the customer responds and guide you through the payment process.
            </p>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard"
               style="background: #667eea; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 16px;">
              View Booking Request
            </a>
          </div>

          <div style="background: #e8f4fd; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">💡 Tips for Success</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.8;">
              <li>Respond within 24 hours for better conversion rates</li>
              <li>Provide a detailed, professional quote</li>
              <li>Include timeline and any relevant terms</li>
              <li>Be transparent about pricing and expectations</li>
            </ul>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Good luck with your new booking! We're here to support you throughout the process.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email: professionalEmail }];
    sendSmtpEmail.subject = "🎉 New Booking Request for Your Project!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixera Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send booking notification email:', error);
    return false;
  }
};

// ============================================================
// RFQ & Quotation Emails
// ============================================================

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const buildBookingLink = (bookingId: string) =>
  `${FRONTEND_URL}/bookings/${escapeHtml(bookingId)}`;

const buildEmailButton = (href: string, label: string, color = '#667eea') => `
  <div style="text-align: center; margin: 25px 0;">
    <a href="${href}" style="background: ${color}; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
      ${escapeHtml(label)}
    </a>
  </div>
`;

const sendEmail = async (to: string, subject: string, htmlContent: string): Promise<boolean> => {
  try {
    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    sendSmtpEmail.sender = {
      name: 'Fixera Team',
      email: process.env.FROM_EMAIL || 'anafariya@gmail.com',
    };
    await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error(`Failed to send email "${subject}" to ${to}:`, error);
    return false;
  }
};

// Professional receives RFQ notification
export const sendRfqReceivedEmail = async (
  profEmail: string, profName: string, customerName: string, serviceType: string, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('New Request for Quote')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          You have received a new Request for Quote from <strong>${escapeHtml(customerName)}</strong> for <strong>${escapeHtml(serviceType)}</strong>.
        </p>
        <p style="color: #666; line-height: 1.6;">
          Please review the details and respond within a reasonable timeframe.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Request')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, 'New Request for Quote - Fixera', content);
};

// Customer notified that professional accepted RFQ
export const sendRfqAcceptedEmail = async (
  custEmail: string, custName: string, profName: string, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Your Request Has Been Accepted')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          Great news! <strong>${escapeHtml(profName)}</strong> has accepted your request and is preparing a detailed quotation for you.
        </p>
        <p style="color: #666; line-height: 1.6;">
          You will receive the quotation within 4 working days. We'll notify you as soon as it's ready.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, 'Your Request Has Been Accepted - Fixera', content);
};

// Customer notified that professional rejected RFQ
export const sendRfqRejectedEmail = async (
  custEmail: string, custName: string, profName: string, reason: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Request Update')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          Unfortunately, <strong>${escapeHtml(profName)}</strong> is unable to take on your request at this time.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          Don't worry — you can search for other professionals on Fixera who can help with your project.
        </p>
        ${buildEmailButton(`${FRONTEND_URL}/search`, 'Find Other Professionals')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, 'Request Update - Fixera', content);
};

// Customer receives quotation
export const sendQuotationReceivedEmail = async (
  custEmail: string, custName: string, profName: string, quotationNumber: string, amount: number, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('New Quotation Received')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has submitted a detailed quotation for your request.
        </p>
        <div style="background: #fff; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <p style="color: #666; margin: 0 0 5px 0; font-size: 14px;">Quotation ${escapeHtml(quotationNumber)}</p>
          <p style="font-size: 28px; font-weight: bold; color: #667eea; margin: 0;">&euro;${amount.toFixed(2)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          Review the full details including scope, warranty, materials, and payment schedule.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review Quotation')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, `Quotation ${quotationNumber} Received - Fixera`, content);
};

// Customer receives updated quotation
export const sendQuotationUpdatedEmail = async (
  custEmail: string, custName: string, profName: string, quotationNumber: string, version: number, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Updated')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has updated quotation <strong>${escapeHtml(quotationNumber)}</strong> (version ${version}).
        </p>
        <p style="color: #666; line-height: 1.6;">
          Please review the updated details and changes.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review Updated Quotation')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, `Quotation ${quotationNumber} Updated - Fixera`, content);
};

// Professional notified that customer accepted quotation
export const sendQuotationAcceptedEmail = async (
  profEmail: string, profName: string, custName: string, quotationNumber: string, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Accepted!')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Congratulations ${escapeHtml(profName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> has accepted your quotation <strong>${escapeHtml(quotationNumber)}</strong>. Payment is being processed.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking', '#4CAF50')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, `Quotation ${quotationNumber} Accepted - Fixera`, content);
};

// Professional notified that customer rejected quotation
export const sendQuotationRejectedEmail = async (
  profEmail: string, profName: string, custName: string, quotationNumber: string, reason: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Feedback')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> has requested changes to quotation <strong>${escapeHtml(quotationNumber)}</strong>.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Feedback:</strong> ${escapeHtml(reason)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          You can revise and resubmit your quotation based on the customer's feedback.
        </p>
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, `Quotation Feedback - ${quotationNumber} - Fixera`, content);
};

// Professional receives RFQ deadline reminder
export const sendRfqDeadlineReminderEmail = async (
  profEmail: string, profName: string, daysRemaining: number, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Deadline Reminder')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          This is a reminder that you have <strong>${daysRemaining} working day${daysRemaining !== 1 ? 's' : ''}</strong> remaining to submit your quotation.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;">
            If no quotation is submitted by the deadline, the request will be automatically cancelled.
          </p>
        </div>
        ${buildEmailButton(buildBookingLink(bookingId), 'Submit Quotation')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, 'Quotation Deadline Reminder - Fixera', content);
};

// Both parties notified about expired RFQ deadline
export const sendRfqDeadlineExpiredEmail = async (
  profEmail: string, profName: string, custEmail: string, custName: string, bookingId: string
): Promise<boolean> => {
  // Send to professional
  const profContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Deadline Expired')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          The deadline to submit your quotation has passed and the request has been automatically cancelled.
        </p>
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const profResult = await sendEmail(profEmail, 'Quotation Deadline Expired - Fixera', profContent);
  if (!profResult) {
    console.error(`[Email] Failed to send RFQ deadline expired email to professional: ${profEmail}`);
  }

  // Send to customer
  const custContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Request Update')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          Unfortunately, the professional did not submit a quotation within the required timeframe. Your request has been cancelled.
        </p>
        <p style="color: #666; line-height: 1.6;">
          You can search for other professionals on Fixera who can help with your project.
        </p>
        ${buildEmailButton(`${FRONTEND_URL}/search`, 'Find Other Professionals')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const custResult = await sendEmail(custEmail, 'Request Update - Fixera', custContent);
  if (!custResult) {
    console.error(`[Email] Failed to send RFQ deadline expired email to customer: ${custEmail}`);
  }
  return profResult && custResult;
};

// Customer receives direct quotation from professional
export const sendDirectQuotationEmail = async (
  custEmail: string, custName: string, profName: string, quotationNumber: string, amount: number, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('You Received a Quotation')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has sent you a quotation.
        </p>
        <div style="background: #fff; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <p style="color: #666; margin: 0 0 5px 0; font-size: 14px;">Quotation ${escapeHtml(quotationNumber)}</p>
          <p style="font-size: 28px; font-weight: bold; color: #667eea; margin: 0;">&euro;${amount.toFixed(2)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          Review the full details and accept or request changes.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review Quotation')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, `Quotation from ${profName} - Fixera`, content);
};

