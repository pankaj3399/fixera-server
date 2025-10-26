import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

// Change password for team members and other users
export const changePassword = async (req: Request, res: Response, next: NextFunction) => {
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
        const user = await User.findById(decoded.id).select('+password');

        if (!user) {
            return res.status(404).json({
                success: false,
                msg: "User not found"
            });
        }

        const { currentPassword, newPassword } = req.body;

        // Validate input
        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                msg: "Current password and new password are required"
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                msg: "New password must be at least 6 characters long"
            });
        }

        // Verify current password
        const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password!);
        if (!isCurrentPasswordValid) {
            return res.status(401).json({
                success: false,
                msg: "Current password is incorrect"
            });
        }

        // Check if new password is different from current
        const isSamePassword = await bcrypt.compare(newPassword, user.password!);
        if (isSamePassword) {
            return res.status(400).json({
                success: false,
                msg: "New password must be different from current password"
            });
        }

        console.log(`🔒 PASSWORD: User ${user.email} (${user.role}) is changing password`);

        // Hash new password
        const hashedNewPassword = await bcrypt.hash(newPassword, 12);
        
        // Update password
        user.password = hashedNewPassword;
        await user.save();

        console.log(`✅ PASSWORD: Password changed successfully for ${user.email} (${user.role})`);

        res.status(200).json({
            success: true,
            msg: "Password changed successfully",
            data: {
                user: {
                    _id: user._id,
                    name: user.name,
                    email: user.email,
                    role: user.role
                }
            }
        });

    } catch (error) {
        console.error("❌ PASSWORD: Error changing password:", error);
        res.status(500).json({
            success: false,
            msg: "Internal server error"
        });
    }
};

// Reset password for employees (by company admin)
export const resetEmployeePassword = async (req: Request, res: Response, next: NextFunction) => {
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
                msg: "Only professionals can reset employee passwords"
            });
        }

        const { employeeId, newPassword } = req.body;

        // Validate input
        if (!employeeId || !newPassword) {
            return res.status(400).json({
                success: false,
                msg: "Employee ID and new password are required"
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                msg: "New password must be at least 6 characters long"
            });
        }

        // Find the employee
        const employee = await User.findOne({
            _id: employeeId,
            role: 'employee',
            'employee.companyId': (professional._id as mongoose.Types.ObjectId).toString()
        }).select('+password');

        if (!employee) {
            return res.status(404).json({
                success: false,
                msg: "Employee not found or not associated with your company"
            });
        }

        // Only allow for employees managed by company (non-email employees)
        if (employee.employee?.hasEmail && !employee.employee?.managedByCompany) {
            return res.status(403).json({
                success: false,
                msg: "Can only reset passwords for company-managed employees"
            });
        }

        console.log(`🔒 PASSWORD: Professional ${professional.email} resetting password for employee ${employee.name}`);

        // Hash new password
        const hashedNewPassword = await bcrypt.hash(newPassword, 12);

        // Update password
        employee.password = hashedNewPassword;
        await employee.save();

        console.log(`✅ PASSWORD: Password reset successfully for employee ${employee.name} by ${professional.email}`);

        res.status(200).json({
            success: true,
            msg: "Employee password reset successfully",
            data: {
                employee: {
                    _id: employee._id,
                    name: employee.name,
                    email: employee.employee?.hasEmail ? employee.email : undefined
                }
            }
        });

    } catch (error) {
        console.error("❌ PASSWORD: Error resetting employee password:", error);
        res.status(500).json({
            success: false,
            msg: "Internal server error"
        });
    }
};