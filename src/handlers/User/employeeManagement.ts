import { Request, Response, NextFunction } from "express";
import User, { IUser } from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { sendTeamMemberInvitationEmail } from "../../utils/emailService";
import crypto from 'crypto';
import mongoose from 'mongoose';

// Generate random password
const generatePassword = (): string => {
    return crypto.randomBytes(8).toString('hex');
};

// Invite employee with email
export const inviteEmployee = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = req.cookies?.['auth-token'];
        
        if (!token) {
            return res.status(401).json({
                success: false,
                msg: "Authentication required"
            });
        }

        let decoded: { id: string } | null = null;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
        } catch (err) {
            return res.status(401).json({
                success: false,
                msg: "Invalid authentication token"
            });
        }

        await connecToDatabase();
        const professional = await User.findById(decoded.id);

        if (!professional) {
            return res.status(404).json({
                success: false,
                msg: "Professional not found"
            });
        }

        // Check if user is an approved professional
        if (professional.role !== 'professional' || professional.professionalStatus !== 'approved') {
            return res.status(403).json({
                success: false,
                msg: "Only approved professionals can invite employees"
            });
        }

        const { name, email, hasEmail = true } = req.body;

        // Validate required fields
        if (!name) {
            return res.status(400).json({
                success: false,
                msg: "Employee name is required"
            });
        }

        if (hasEmail && !email) {
            return res.status(400).json({
                success: false,
                msg: "Email is required when hasEmail is true"
            });
        }

        // If hasEmail is true, check if email already exists
        if (hasEmail && email) {
            const existingUser = await User.findOne({ email: email.toLowerCase() });
            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    msg: "User with this email already exists"
                });
            }
        }

        console.log(`👥 EMPLOYEE: Professional ${professional.email} inviting employee: ${name} (hasEmail: ${hasEmail})`);

        let employee: IUser;
        let generatedPassword: string | null = null;

        if (hasEmail && email) {
            // Create employee with email
            generatedPassword = generatePassword();
            const hashedPassword = await bcrypt.hash(generatedPassword, 12);

            employee = new User({
                name: name.trim(),
                email: email.toLowerCase().trim(),
                phone: `+1000000${Date.now().toString().slice(-4)}`, // Clean placeholder phone for employees
                password: hashedPassword,
                role: 'employee',
                isEmailVerified: true, // Employees' email is verified when they accept invitation
                isPhoneVerified: true, // Employees don't need phone verification
                employee: {
                    companyId: (professional._id as mongoose.Types.ObjectId).toString(),
                    invitedBy: (professional._id as mongoose.Types.ObjectId).toString(),
                    invitedAt: new Date(),
                    isActive: true,
                    hasEmail: true,
                    availabilityPreference: 'personal',
                    managedByCompany: false
                }
            });
        } else {
            // Create employee without email (managed by company)
            employee = new User({
                name: name.trim(),
                email: `no-email-${Date.now()}@company.local`, // Clean placeholder email
                phone: `+1000000${Date.now().toString().slice(-4)}`, // Clean placeholder phone for employees
                password: await bcrypt.hash('temp-password-123', 12), // Temporary password
                role: 'employee',
                isEmailVerified: true, // Employees don't require email verification
                isPhoneVerified: true, // Employees don't require phone verification
                employee: {
                    companyId: (professional._id as mongoose.Types.ObjectId).toString(),
                    invitedBy: (professional._id as mongoose.Types.ObjectId).toString(),
                    invitedAt: new Date(),
                    acceptedAt: new Date(), // Auto-accept for non-email members
                    isActive: true,
                    hasEmail: false,
                    availabilityPreference: 'personal',
                    managedByCompany: true
                }
            });
        }

        await employee.save();

        // Send email invitation if employee has email
        let emailSent = false;
        if (hasEmail && email && generatedPassword) {
            try {
                await sendTeamMemberInvitationEmail(
                    email,
                    name,
                    professional.businessInfo?.companyName || professional.name,
                    email,
                    generatedPassword
                );
                emailSent = true;
                console.log(`📧 EMPLOYEE: Invitation email sent to ${email}`);
            } catch (error) {
                console.error(`❌ EMPLOYEE: Failed to send invitation email to ${email}:`, error);
            }
        }

        console.log(`✅ EMPLOYEE: Employee ${name} invited by ${professional.email} (hasEmail: ${hasEmail})`);

        const responseData: any = {
            employee: {
                _id: employee._id,
                name: employee.name,
                email: hasEmail ? employee.email : undefined,
                role: employee.role,
                hasEmail: hasEmail,
                availabilityPreference: employee.employee?.availabilityPreference,
                invitedAt: employee.employee?.invitedAt,
                isActive: employee.employee?.isActive
            },
            emailSent: emailSent
        };

        // Include credentials in response for non-email members (for company admin to manage)
        if (!hasEmail) {
            responseData.tempCredentials = {
                email: employee.email,
                password: 'temp-password-123'
            };
        }

        res.status(201).json({
            success: true,
            msg: hasEmail
                ? "Employee invitation sent successfully"
                : "Employee added successfully",
            data: responseData
        });

    } catch (error) {
        console.error("❌ EMPLOYEE: Error inviting employee:", error);
        res.status(500).json({
            success: false,
            msg: "Internal server error"
        });
    }
};

// Get employees for a professional
export const getEmployees = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = req.cookies?.['auth-token'];
        
        if (!token) {
            return res.status(401).json({
                success: false,
                msg: "Authentication required"
            });
        }

        let decoded: { id: string } | null = null;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
        } catch (err) {
            return res.status(401).json({
                success: false,
                msg: "Invalid authentication token"
            });
        }

        await connecToDatabase();
        const professional = await User.findById(decoded.id);

        if (!professional) {
            return res.status(404).json({
                success: false,
                msg: "Professional not found"
            });
        }

        // Check if user is a professional
        if (professional.role !== 'professional') {
            return res.status(403).json({
                success: false,
                msg: "Only professionals can view employees"
            });
        }

        // Get all employees for this professional
        const employees = await User.find({
            role: 'employee',
            'employee.companyId': (professional._id as mongoose.Types.ObjectId).toString(),
            'employee.isActive': true
        }).select('-password -verificationCode -verificationCodeExpires');

        console.log(`👥 EMPLOYEE: Retrieved ${employees.length} employees for ${professional.email}`);

        res.status(200).json({
            success: true,
            data: {
                employees: employees.map(member => ({
                    _id: member._id,
                    name: member.name,
                    email: member.employee?.hasEmail ? member.email : undefined,
                    hasEmail: member.employee?.hasEmail,
                    role: member.role,
                    availabilityPreference: member.employee?.availabilityPreference,
                    invitedAt: member.employee?.invitedAt,
                    acceptedAt: member.employee?.acceptedAt,
                    isActive: member.employee?.isActive,
                    managedByCompany: member.employee?.managedByCompany,
                    availability: member.availability,
                    blockedDates: member.blockedDates,
                    blockedRanges: member.blockedRanges
                })),
                totalCount: employees.length
            }
        });

    } catch (error) {
        console.error("❌ EMPLOYEE: Error getting employees:", error);
        res.status(500).json({
            success: false,
            msg: "Internal server error"
        });
    }
};

// Update employee status (activate/deactivate)
export const updateEmployeeStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = req.cookies?.['auth-token'];
        
        if (!token) {
            return res.status(401).json({
                success: false,
                msg: "Authentication required"
            });
        }

        let decoded: { id: string } | null = null;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
        } catch (err) {
            return res.status(401).json({
                success: false,
                msg: "Invalid authentication token"
            });
        }

        await connecToDatabase();
        const professional = await User.findById(decoded.id);

        if (!professional || professional.role !== 'professional') {
            return res.status(403).json({
                success: false,
                msg: "Only professionals can update employee status"
            });
        }

        const { employeeId } = req.params;
        const { isActive } = req.body;

        const employee = await User.findOne({
            _id: employeeId,
            role: 'employee',
            'employee.companyId': (professional._id as mongoose.Types.ObjectId).toString()
        });

        if (!employee) {
            return res.status(404).json({
                success: false,
                msg: "Employee not found"
            });
        }

        employee.employee!.isActive = isActive;
        await employee.save();

        console.log(`🔄 EMPLOYEE: ${professional.email} ${isActive ? 'activated' : 'deactivated'} employee ${employee.name}`);

        res.status(200).json({
            success: true,
            msg: `Employee ${isActive ? 'activated' : 'deactivated'} successfully`,
            data: {
                employee: {
                    _id: employee._id,
                    name: employee.name,
                    isActive: employee.employee?.isActive
                }
            }
        });

    } catch (error) {
        console.error("❌ EMPLOYEE: Error updating employee status:", error);
        res.status(500).json({
            success: false,
            msg: "Internal server error"
        });
    }
};

// Employee accepts invitation (first login)
export const acceptInvitation = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                msg: "Email and password are required"
            });
        }

        await connecToDatabase();

        const employee = await User.findOne({
            email: email.toLowerCase(),
            role: 'employee'
        }).select('+password');

        if (!employee) {
            return res.status(404).json({
                success: false,
                msg: "Employee not found"
            });
        }

        const isPasswordValid = await bcrypt.compare(password, employee.password!);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                msg: "Invalid credentials"
            });
        }

        // Mark as accepted if not already
        if (!employee.employee?.acceptedAt) {
            employee.employee!.acceptedAt = new Date();
            await employee.save();
        }

        // Generate JWT token
        const token = jwt.sign(
            { id: employee._id },
            process.env.JWT_SECRET!,
            { expiresIn: '7d' }
        );

        res.cookie('auth-token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        console.log(`✅ EMPLOYEE: Employee ${employee.name} accepted invitation and logged in`);

        res.status(200).json({
            success: true,
            msg: "Login successful",
            data: {
                user: {
                    _id: employee._id,
                    name: employee.name,
                    email: employee.email,
                    role: employee.role,
                    employee: employee.employee
                }
            }
        });

    } catch (error) {
        console.error("❌ EMPLOYEE: Error accepting invitation:", error);
        res.status(500).json({
            success: false,
            msg: "Internal server error"
        });
    }
};