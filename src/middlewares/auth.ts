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
        msg: 'Access denied. No authentication token provided.' 
      });
    }

    // 4. Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };


    // 6. Find user and exclude password
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({ 
        success: false,
        msg: 'Access denied. User not found.' 
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
        msg: 'Access denied. Invalid token.' 
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
        msg: 'Access denied. Token expired.' 
      });
    }

    return res.status(500).json({ 
      success: false,
      msg: 'Server error during authentication.' 
    });
  }
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
          message: 'Access denied. No authentication token provided.'
        });
      }

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };

      // Find user
      const user = await User.findById(decoded.id).select('-password');

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Access denied. User not found.'
        });
      }

      // Check if user's role is in the allowed roles
      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({
          success: false,
          message: `Access denied. ${allowedRoles.join(' or ')} role required.`
        });
      }

      // For professionals, add professionalId to user object for convenience
      if (user.role === 'professional') {
        (req.user as any) = {
          ...user.toObject(),
          professionalId: String(user._id)
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
          message: 'Access denied. Invalid token.'
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
          message: 'Access denied. Token expired.'
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Server error during authentication.'
      });
    }
  };
};

