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

// Send OTP email using Brevo
export const sendOTPEmail = async (email: string, otp: string, userName: string): Promise<boolean> => {
  try {
    const emailAPI = createEmailAPI();
    
    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px;">Fixera</h1>
          <p style="color: white; margin: 10px 0 0 0; font-size: 16px;">Email Verification</p>
        </div>
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${userName}!</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for joining Fixera! To complete your registration, please use the verification code below:
          </p>
          
          <div style="background: #fff; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 10px 0; font-size: 18px;">Your Verification Code</h3>
            <div style="font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 8px; font-family: 'Courier New', monospace;">
              ${otp}
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
          
          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
            <p style="color: #999; font-size: 12px; margin: 0;">
              © 2024 Fixera. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    `;

    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Verify Your Fixera Account";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixera Team", 
      email: process.env.FROM_EMAIL || "testing@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
  }
};
