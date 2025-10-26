import mongoose from "mongoose";

export type UserRole = "admin" | "visitor" | "customer" | "professional" | "employee"


 export interface User{
    _id:mongoose.Types.ObjectId;
    name:string;
    password:string;
    email:string;
    createdAt:Date;
    updatedAt:Date;
    role:UserRole
}


