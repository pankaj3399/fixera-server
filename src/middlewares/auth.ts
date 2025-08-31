import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User, { IUser } from '../models/user';
import connectToDatabase from '../config/db'; // Import your database connection

// Extend the Express Request interface to include a 'user' property
declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

export const protect = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token: string | undefined;

    // 1. Check for token in cookies first (priority for cookie-based auth)
    if (req.cookies && req.cookies['auth-token']) {
      token = req.cookies['auth-token'];
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

