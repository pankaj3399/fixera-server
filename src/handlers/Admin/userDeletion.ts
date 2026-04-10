import { Request, Response } from "express";
import User from "../../models/user";
import { deleteUserData } from "../../utils/deleteUserData";

export const deleteUser = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?._id;
    if (!adminId) {
      return res.status(401).json({ success: false, msg: "Admin authentication required" });
    }

    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.role === "admin") {
      return res.status(403).json({ success: false, msg: "Cannot delete admin users" });
    }

    await deleteUserData(user._id);

    return res.status(200).json({ success: true, msg: `User ${user.email} and all associated data deleted` });
  } catch (error: any) {
    console.error("Delete user error:", error);
    return res.status(500).json({ success: false, msg: "Failed to delete user" });
  }
};
