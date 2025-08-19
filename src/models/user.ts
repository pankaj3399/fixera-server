import { Schema, model, Document } from "mongoose";

export type UserRole = "admin" | "visitor" | "customer" | "professional";

export interface IUser extends Document {
    name: string;
    password?: string;
    email: string;
    phone: string;
    isPhoneVerified: boolean;
    isEmailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
    role: UserRole;
    verificationCode?: string;
    verificationCodeExpires?: Date;
}

const UserSchema = new Schema<IUser>({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
    },
    phone: {
        type: String,
        required: [true, 'Phone number is required'],
        unique: true,
    },
    isPhoneVerified: {
        type: Boolean,
        default: false
    },
    isEmailVerified: {
        type: Boolean,
        default: false
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters long'],
        select: false
    },
    role: {
        type: String,
        enum: ['admin', 'visitor', 'customer', 'professional'],
        default: 'customer'
    },

    verificationCode: {
        type: String,
        select: false 
    },
    verificationCodeExpires: {
        type: Date,
        select: false 
    }
}, {
    timestamps: true
});

const User = model<IUser>('User', UserSchema);

export default User;