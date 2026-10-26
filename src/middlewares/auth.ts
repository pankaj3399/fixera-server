import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User, { IUser } from '../models/user';
import connectToDatabase from '../config/db'; // Import your database connection

export const protect = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token: string | undefined;

    // 1. Check for token in cookies first (priority for cookie-based auth)
    if (req.cookies && req.cookies['auth-token']) {
      token = req.cookies['auth-token'];
    }

    // 2. If no cookie, check Authorization header (Bearer token fallback)
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // 3. If no token found, return unauthorized
    if (!token) {
      return res.status(401).json({
        success: false,
        msg: 'Please sign in to continue.',
        code: 'AUTH_REQUIRED'
      });
    }

    // 4. Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };


    // 6. Find user and exclude password
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({ 
        success: false,
        msg: 'Your account is no longer available. Please sign in again.',
        code: 'AUTH_REQUIRED'
      });
    }
    if (user.deletedAt || user.isAnonymized) {
      return res.status(403).json({
        success: false,
        msg: 'This account has been deleted.',
        code: 'FORBIDDEN'
      });
    }
    if (user.accountStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        msg: 'This account is suspended.',
        code: 'FORBIDDEN'
      });
    }

    // 7. Attach user to request object
    req.user = user;

    // 8. Continue to next middleware
    next();

  } catch (error: any) {
    console.error('Auth middleware error:', error);
    
    // Handle specific JWT errors
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false,
        msg: 'Your session is invalid. Please sign in again.',
        code: 'AUTH_REQUIRED'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      // Clear the expired cookie
      res.clearCookie('auth-token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
      });
      
      return res.status(401).json({ 
        success: false,
        msg: 'Your session has expired. Please sign in again.',
        code: 'AUTH_REQUIRED'
      });
    }

    return res.status(500).json({ 
      success: false,
      msg: "We couldn't verify your session. Please try again.",
      code: 'INTERNAL'
    });
  }
};

/** Attach an active user when a valid token is present without making auth mandatory. */
export const optionalProtect = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const token =
      req.cookies?.['auth-token'] ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.split(' ')[1]
        : undefined);
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    const user = await User.findById(decoded.id).select('-password');
    if (
      user &&
      !user.deletedAt &&
      !user.isAnonymized &&
      !['suspended', 'rejected'].includes(user.accountStatus || '')
    ) {
      req.user = user;
    }
  } catch {
    // Public endpoints remain public when an optional credential is stale.
  }
  return next();
};

/**
 * Role-based authorization middleware
 * @param allowedRoles - Array of roles that are allowed to access the route
 */
export const authMiddleware = (allowedRoles: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let token: string | undefined;

      // Check for token in cookies
      if (req.cookies && req.cookies['auth-token']) {
        token = req.cookies['auth-token'];
      }

      // Fallback: check Authorization header (Bearer token)
      if (!token && req.headers.authorization?.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      }

      if (!token) {
        return res.status(401).json({
          success: false,
          msg: 'Please sign in to continue.',
          message: 'Please sign in to continue.',
          code: 'AUTH_REQUIRED'
        });
      }

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };

      // Find user
      const user = await User.findById(decoded.id).select('-password');

      if (!user) {
        return res.status(401).json({
          success: false,
          msg: 'Your account is no longer available. Please sign in again.',
          message: 'Your account is no longer available. Please sign in again.',
          code: 'AUTH_REQUIRED'
        });
      }
      if (user.deletedAt || user.isAnonymized) {
        return res.status(403).json({
          success: false,
          msg: 'This account has been deleted.',
          message: 'This account has been deleted.',
          code: 'FORBIDDEN'
        });
      }
      if (user.accountStatus === 'suspended') {
        return res.status(403).json({
          success: false,
          msg: 'This account is suspended.',
          message: 'This account is suspended.',
          code: 'FORBIDDEN'
        });
      }

      // Check if user's role is in the allowed roles
      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({
          success: false,
          msg: `You don't have permission to do that. ${allowedRoles.join(' or ')} access is required.`,
          message: `You don't have permission to do that. ${allowedRoles.join(' or ')} access is required.`,
          code: 'FORBIDDEN'
        });
      }

      // For professionals, add professionalId to user object for convenience
      if (user.role === 'professional') {
        (req.user as any) = {
          ...user.toObject(),
          professionalId: user._id
        };
      } else {
        req.user = user;
      }

      next();

    } catch (error: any) {
      console.error('Auth middleware error:', error);

      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          msg: 'Your session is invalid. Please sign in again.',
          message: 'Your session is invalid. Please sign in again.',
          code: 'AUTH_REQUIRED'
        });
      }

      if (error.name === 'TokenExpiredError') {
        res.clearCookie('auth-token', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/'
        });

        return res.status(401).json({
          success: false,
          msg: 'Your session has expired. Please sign in again.',
          message: 'Your session has expired. Please sign in again.',
          code: 'AUTH_REQUIRED'
        });
      }

      return res.status(500).json({
        success: false,
        msg: "We couldn't verify your session. Please try again.",
        message: "We couldn't verify your session. Please try again.",
        code: 'INTERNAL'
      });
    }
  };
};
