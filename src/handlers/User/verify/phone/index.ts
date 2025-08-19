import { Request,Response,NextFunction } from "express";
import User from "../../../../models/user";
import twilio from 'twilio'

// Validate Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

if (!accountSid || !authToken || !verifyServiceSid) {
  console.error("Missing Twilio configuration. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID environment variables.");
}

export const VerifyPhone = async (req:Request,res:Response,next:NextFunction)=>{
    try{
        const {phone} = req.body;
        
        // Check if Twilio is properly configured
        if (!accountSid || !authToken || !verifyServiceSid) {
            return res.status(500).json({
                success: false,
                msg: "SMS service is not configured. Please contact support."
            });
        }

        if(!phone){
            return res.status(400).json({
                success: false,
                msg:"Phone number is required"
            });
        }

        const twilioClient = twilio(accountSid, authToken);

        const user = await User.findOne({phone});

        if(!user){
            return res.status(404).json({
                success: false,
                msg:"User not found"
            });
        }

        const service = await twilioClient.verify.v2.services(verifyServiceSid).verifications.create({
            channel:"sms",
            to:phone
        });


        return res.status(200).json({
            success: true,
            msg:"OTP sent to your phone number"
        })    
    }
    catch(e){
        console.error("Twilio verification error:", e);
        next(e);
    }
}



export const VerifyPhoneCheck = async(req:Request,res:Response,next:NextFunction)=>{
    try{
        const {phone,otp} = req.body;
        
        // Check if Twilio is properly configured
        if (!accountSid || !authToken || !verifyServiceSid) {
            return res.status(500).json({
                success: false,
                msg: "SMS service is not configured. Please contact support."
            });
        }

        if(!phone || !otp){
            return res.status(400).json({
                success: false,
                msg:"Phone number and OTP are required"
            });
        }

        const twilioClient = twilio(accountSid, authToken);

        const service = await twilioClient.verify.v2.services(verifyServiceSid).verificationChecks.create({
            code:otp,
            to:phone
        });
        
        if(service.status==="approved"){
            await User.findOneAndUpdate({phone},{isPhoneVerified:true});
            return res.status(200).json({
                success: true,
                msg:"Phone number verified successfully"
            });
        }else{
            return res.status(400).json({
                success: false,
                msg:"Invalid OTP"
            });
        }
    }
    catch(e){
        console.error("Twilio verification check error:", e);
        next(e);
    }
}